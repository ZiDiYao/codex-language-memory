"""Protocol-only MCP fixture for measuring model work; never touches real records.

Frozen rich and lightweight schemas intentionally return immediate fixed replies.
Real persistence is measured separately by benchmark_capture.mjs.
"""
import json
import sys
import time
from pathlib import Path

mode, log_path = sys.argv[1:3]
kind = {"type": "string", "enum": ["word", "expression", "grammar", "correction"]}
text = {"type": "string"}
base = {"kind": kind, "language": text, "title": text, "context": text, "corrected_sentence": text}
rich = {**base, "sense_key": text, "meaning": text, "explanation": text,
        "examples": {"type": "array", "minItems": 2, "maxItems": 5, "items": {
            "type": "object", "properties": {"text": text, "translation": text}, "required": ["text"], "additionalProperties": False}},
        "scenes": {"type": "array", "items": text}}
properties = rich if mode == "legacy" else base
required = ["kind", "language", "title"] + (["sense_key", "meaning", "explanation", "examples", "scenes"] if mode == "legacy" else [])
tools = [
    {"name": "get_settings", "description": "Read the confirmed preferences once for this isolated learning exchange.",
     "inputSchema": {"type": "object", "properties": {"for_capture": {"type": "boolean"}}, "additionalProperties": False}},
    {"name": "save_points" if mode == "legacy" else "capture_points",
     "description": ("Save the observed learning gap with generated explanation, two distinct example sentences, translations, and scenes."
                     if mode == "legacy" else "Record only the observed learning target and necessary original context. Backend AI handles content and scenes."),
     "inputSchema": {"type": "object", "properties": {
         "request_id": text, "source": {"type": "string", "enum": ["automatic", "explicit"]},
         "expected_connection_epoch": {"type": "integer"},
         "items": {"type": "array", "minItems": 1, "items": {"type": "object", "properties": properties,
                    "required": required, "additionalProperties": False}}},
         "required": ["request_id", "items"], "additionalProperties": False}}
]
# This fixture does not modify any library: both calls only return test replies.
# Marking these protocol stubs read-only also avoids measuring approval UI that
# cannot be answered by an ephemeral noninteractive Codex process.
for tool in tools:
    tool["annotations"] = {"readOnlyHint": True, "destructiveHint": False, "openWorldHint": False}

def reply(identifier, value):
    print(json.dumps({"jsonrpc": "2.0", "id": identifier, "result": value}, ensure_ascii=False), flush=True)

for line in sys.stdin:
    try:
        request = json.loads(line)
    except ValueError:
        continue
    identifier = request.get("id")
    method = request.get("method")
    if identifier is None:
        continue
    if method == "initialize":
        reply(identifier, {"protocolVersion": request.get("params", {}).get("protocolVersion", "2025-03-26"),
                           "capabilities": {"tools": {}}, "serverInfo": {"name": "isolated-sayrove-model-benchmark", "version": "1.0.0"}})
    elif method == "tools/list":
        reply(identifier, {"tools": tools})
    elif method == "tools/call":
        params = request.get("params", {})
        with Path(log_path).open("a") as output:
            output.write(json.dumps({"at_ns": time.time_ns(), "name": params.get("name"),
                                     "arguments": params.get("arguments", {})}, ensure_ascii=False) + "\n")
        if params.get("name") == "get_settings":
            value = {"enabled": True, "first_language": "zh", "explanation_language": None,
                     "enabled_types": ["word", "expression", "grammar", "correction"],
                     "_connection": {"state": "connected", "epoch": 1},
                     "_capture": {"capture_ready": True, "scene_names": ["Food & cooking", "Cleaning & hygiene", "Everyday conversation"],
                                  "reuse_for_seconds": 120}}
        else:
            value = {"status": "processed", "replayed": False,
                     "results": [{"index": 0, "status": "added", "id": 1, "encounter_count": 1,
                                  **({"enrichment_state": "pending"} if mode == "light" else {})}]}
        reply(identifier, {"content": [{"type": "text", "text": json.dumps(value, ensure_ascii=False)}], "structuredContent": value})
    else:
        reply(identifier, {})
