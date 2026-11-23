#!/usr/bin/env python3
"""Measure actual Codex CLI replies with isolated protocol tools, no real records.

This is a controlled prompt/schema experiment, not a production end-to-end trace.
Every arm uses the same explicit model/reasoning and concise learning question.
"""
import argparse
import hashlib
import json
import math
import statistics
import subprocess
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
FIXTURE = ROOT / "scripts/benchmark_model_fixture.py"
QUESTIONS = ["芹菜的英文咋说", "rinse 是什么意思", "hold a grudge 怎么用", "I very like it 这样说自然吗", "turn off 和 turn on 分别什么意思", "一根芹菜用英文怎么说"]
COMMON = """This is an isolated Sayrove latency experiment. Use only the explicitly provided benchmark MCP tools; do not read files, browse, or call other tools. Any learning records here are test-only fixture records, never a real user's library. Respond to the learning question in Chinese with a concise answer of at most 80 Chinese characters plus at most one English example. Do not mention benchmarking in your answer. Do not ask a follow-up question.\n"""
LEGACY = """Apply the current rich capture contract: first call get_settings(for_capture=true) to read confirmed recording/language preferences. The returned scene catalog is enough; no extra reads. Then answer the learning question and save the observed learning point using save_points with a unique request_id and source=automatic. You must generate kind, target language, canonical title, stable sense_key, Chinese meaning, useful concise Chinese explanation, at least two distinct English example sentences with Chinese translations, and a suitable scenes list. For a correction keep the original in context and revision in corrected_sentence. Respect recording and enabled types. Wait for the confirmed save before reporting success.\n"""
LIGHT = """Apply the lightweight capture contract: first call get_settings(for_capture=true) to read confirmed recording/language preferences. Then answer the learning question and call capture_points once with a unique request_id and source=automatic. Submit only the observed kind, target language, canonical title and necessary original context; for corrections include corrected_sentence if already provided in teaching. Do not generate definitions, explanations, examples, translations, scenes or sense keys for storage: the backend enriches them asynchronously. Respect recording and enabled types. Wait for confirmed capture before reporting the learning point recorded; do not claim enrichment is complete.\n"""

def aggregate(values):
    ordered = sorted(values)
    return {"samples": len(values), "mean_s": statistics.mean(values), "p50_s": statistics.median(values),
            "p95_s": ordered[max(0, math.ceil(len(values)*.95)-1)], "min_s": ordered[0], "max_s": ordered[-1]}

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--mode", choices=["control", "legacy", "light"], required=True)
    parser.add_argument("--samples", type=int, default=6)
    parser.add_argument("--model", default="gpt-6.1-sol")
    parser.add_argument("--reasoning", default="high")
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    args.output.parent.mkdir(parents=True, exist_ok=True)
    results = []
    prompt_contract = {"control": "No learning plugin is connected. Answer directly without saving.\n", "legacy": LEGACY, "light": LIGHT}[args.mode]
    with tempfile.TemporaryDirectory(prefix="sayrove-model-bench-") as directory:
        for index in range(args.samples):
            question = QUESTIONS[index % len(QUESTIONS)]
            log = Path(directory) / f"calls-{index}.jsonl"
            command = ["codex", "exec", "--ignore-user-config", "--ephemeral", "--skip-git-repo-check", "--json", "--color=never", "-s", "read-only", "-C", directory,
                       "-m", args.model, "-c", f'model_reasoning_effort="{args.reasoning}"']
            if args.mode != "control":
                command += ["-c", 'mcp_servers.sayrove_benchmark.command="/opt/homebrew/bin/python3"',
                            "-c", "mcp_servers.sayrove_benchmark.args=" + json.dumps([str(FIXTURE), args.mode, str(log)])]
            command.append(COMMON + prompt_contract + "\nLearning question: " + question)
            started = time.perf_counter()
            process = subprocess.Popen(command, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
            events = []
            first_reply_s = final_reply_s = turn_started_s = None
            for line in process.stdout:
                elapsed = time.perf_counter() - started
                try: event = json.loads(line)
                except ValueError: continue
                events.append({"elapsed_s": elapsed, "event": event})
                if event.get("type") == "turn.started": turn_started_s = elapsed
                item = event.get("item", {})
                if item.get("type") == "agent_message" and event.get("type") == "item.completed" and first_reply_s is None:
                    first_reply_s = elapsed
                if item.get("type") == "agent_message" and event.get("type") == "item.completed":
                    final_reply_s = elapsed
            stderr = process.stderr.read()
            code = process.wait()
            elapsed = time.perf_counter() - started
            calls = [json.loads(line) for line in log.read_text().splitlines()] if log.exists() else []
            completion = next((x["event"] for x in reversed(events) if x["event"].get("type") == "turn.completed"), None)
            success = code == 0 and completion is not None and first_reply_s is not None
            if args.mode != "control":
                wanted = "save_points" if args.mode == "legacy" else "capture_points"
                success = success and any(c["name"] == wanted for c in calls)
            result = {"index": index, "question": question, "success": success, "exit_code": code,
                      "wall_s": elapsed, "first_agent_message_s": first_reply_s, "final_response_s": final_reply_s, "turn_started_s": turn_started_s,
                      "active_turn_s": elapsed-turn_started_s if turn_started_s is not None else None,
                      "tool_calls": calls, "tool_payload_bytes": sum(len(json.dumps(c["arguments"], ensure_ascii=False).encode()) for c in calls),
                      "usage": completion.get("usage") if completion else None,
                      "events": events, "stderr_warning_lines": [line[:200] for line in stderr.splitlines() if 'WARN' in line]}
            results.append(result)
            report = {"benchmark": "actual-codex-cli-controlled-prompt-and-tool-schema", "mode": args.mode,
                      "model": args.model, "reasoning_effort": args.reasoning,
                      "contract": prompt_contract, "contract_sha256": hashlib.sha256(prompt_contract.encode()).hexdigest(),
                      "fixture_sha256": hashlib.sha256(FIXTURE.read_bytes()).hexdigest(),
                      "scope": "actual model work plus CLI/MCP overhead; fixture replies immediate, no real database or network persistence",
                      "not_measured": ["production Codex app UI streaming", "cloud database latency", "backend enrichment completion"],
                      "results": results,
                      "summary": {field: aggregate([r[field] for r in results if r["success"] and r[field] is not None])
                                  for field in ["wall_s", "active_turn_s", "first_agent_message_s", "final_response_s"]
                                  if any(r["success"] and r[field] is not None for r in results)}}
            args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2)+"\n")
            print(json.dumps({"mode": args.mode, "index": index, "success": success, "wall_s": elapsed,
                              "tool_calls": len(calls), "output_tokens": result["usage"].get("output_tokens") if result["usage"] else None}), flush=True)
            if not success:
                print("Probe failed; inspect sanitized event artifact rather than silently continuing.", flush=True)
                return 1
    print(json.dumps(report["summary"], indent=2), flush=True)
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
