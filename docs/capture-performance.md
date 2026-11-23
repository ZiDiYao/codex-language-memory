# Sayrove lightweight capture: baseline and comparison

Measured on 2026-11-23. Original source commit: `f249d74320a920abb6fdcb10a12ca5cce405c2f1`. The baseline was recorded before production source edits. All learning content in these experiments is isolated synthetic fixture data, never the user's learning library.

## What changed

Codex now submits only kind, target language, title and necessary original context. PostgreSQL commits the raw target, real encounter, idempotency receipt and durable enrichment job atomically; the response does not await AI. A server-side worker generates and validates note content later. Rich capture remains compatible. Scene reads were removed from the desktop's ordinary capture context. The first question still requires settings plus capture (two model/tool rounds); a fresh cached context allows a later question to use one capture.

Backend exact normalization deduplicates ordinary targets. Arbitrary inflections/synonyms are not merged speculatively. Generated meanings can be merged inside an existing word. No fake examples, review evidence or mastery are created to satisfy acceptance. Pending notes cannot be used in quizzes.

## Actual model response experiment

Same `gpt-6.1-sol` with `high` reasoning, same six questions in every arm. All user configuration and real plugins were disabled in ephemeral Codex CLI sessions. The isolated MCP fixture returned immediately without artificial delays; it validates only protocol behavior and records test calls. This measures actual model work, tool-argument generation and CLI/MCP orchestration. It is **not** a production desktop App end-to-end or first-useful-answer measurement. An initial approval-blocked probe is preserved separately and excluded from results.

| Metric | Rich capture baseline | Lightweight capture | No plugin control |
| --- | ---: | ---: | ---: |
| Valid samples | 6 | 6 | 6 |
| Mean full reply, seconds | 16.572 | 14.812 | 6.945 |
| Median full reply, seconds | 16.293 | 13.618 | 5.163 |
| p95 / maximum, seconds | 21.303 | 22.333 | 14.487 |
| Tool calls per question | 2 | 2 | 0 |

Mean full reply decreased **10.62%** (about 1.76 seconds). Mean tool argument bytes fell 799 → 269.83 (**66.23%**); reported output tokens fell 492 → 402.83 (**18.12%**). Output token figures are the CLI's usage fields and are not summed with separately reported reasoning tokens.

The small sample's tail got worse, including an outlier on the correction question. Arms ran in rich → light → control order, so service variation and caching effects are not eliminated. The result is exploratory, not statistical proof of a stable production speedup. First agent narration is not lesson TTFT and is not treated as a useful answer. Lightweight capture still averaged 7.87 seconds above the no-plugin control; generating fewer note fields does not remove model/tool rounds.

Raw data: [baseline](benchmarks/model-baseline.json), [lightweight](benchmarks/model-optimized.json), [control](benchmarks/model-control.json), [excluded probe](benchmarks/model-probe-approval-blocked.json). Each includes prompt/fixture hashes, raw events, call arguments and usage.

## Real backend transport experiment

Disposable local PostgreSQL 17.10, Node v24.19.0; actual loopback HTTP, RSA JWT validation, repository and transaction commits. Each scenario has **8 warmups + 60 measured requests**. Different scenarios use isolated verified principals. Temporary schemas are dropped after each run. Background AI was not running in these timing tests.

All times below are mean milliseconds. Positive reduction means faster; a negative value means slower.

| Scenario | Original baseline | Final lightweight | Final rich recheck | Reduction vs baseline |
| --- | ---: | ---: | ---: | ---: |
| REST new target | 6.591 | 6.959 | 7.203 | -5.58% |
| REST repeated target | 6.524 | 5.167 | 6.658 | +20.80% |
| MCP new target | 6.474 | 5.483 | 7.459 | +15.30% |
| MCP repeated target | 8.069 | 6.402 | 6.217 | +20.66% |

Equal-weight average over the four scenarios (240 measured requests per arm): **6.915 → 6.003 ms**, reduction **13.19%**. This weighting is a test design, not observed user traffic. REST new-target mean worsened; final rich rechecks also varied, including MCP repeats slightly faster than lightweight. Do not claim every endpoint became faster. Raw p50, p95, maxima, sample values and code hashes are included in each artifact.

Raw data: [baseline](benchmarks/capture-baseline.json), [final lightweight](benchmarks/capture-optimized.json), [final rich recheck](benchmarks/capture-legacy-recheck.json). Early exploratory runs are retained with `-early` filenames. These timings exclude model work, internet/cloud transport and enrichment completion; do not add them to the model fixture timings as if they were a measured production total.

## Correctness and builds

- Node backend: **49 passed, zero failures or skips**, including real PostgreSQL, RSA/JWT REST/MCP, Python/PostgreSQL interoperability and migration checks.
- Python desktop/protocol/content/runtime selected suites: **85 passed** (17 routing, 33 account, 12 integration, 6 content-quality, 9 real stdio/lifecycle, 8 release-runtime checks).
- Frontend: **54 passed**; MCP App and cloud web builds passed.
- Frozen desktop `beta.47` archive: **15 acceptance checks passed**, including install, upgrade, rollback, uninstall/reinstall and 25-tool discovery, in an isolated temporary profile. The real user profile was not modified.
- Acceptance found and fixed an obsolete 24-tool runtime health check before delivery. [Package acceptance evidence](benchmarks/beta47-package-acceptance.json).
- Background tests cover concurrent idempotent capture, tenant isolation, settings, lease expiry/recovery, bounded failures, lock order, oldest eligible scheduling, manual/empty notes, manual scenes, deletion, repeated/new senses and legacy incomplete notes. They use deterministic test providers, not live AI.

## Reproduce

Use only a disposable local PostgreSQL database:

```sh
TEST_DATABASE_URL=postgresql://... node scripts/benchmark_capture.mjs --mode=legacy --samples=60 --warmups=8 --output=/tmp/rich.json
TEST_DATABASE_URL=postgresql://... node scripts/benchmark_capture.mjs --mode=light --samples=60 --warmups=8 --output=/tmp/light.json
python3 scripts/benchmark_model_capture.py --mode=legacy --samples=6 --output=/tmp/model-rich.json
python3 scripts/benchmark_model_capture.py --mode=light --samples=6 --output=/tmp/model-light.json
python3 scripts/benchmark_model_capture.py --mode=control --samples=6 --output=/tmp/model-control.json
```

Model commands need an existing Codex CLI login. They perform real model requests using the selected CLI model; they do not need the backend enrichment API key or invoke the user's actual learning plugin. Capture scripts require backend Node dependencies; model fixtures use Python's standard library.

## Rollout status and unmeasured work

Implementation and tests are local to this isolated checkout, on branch `codex/lightweight-capture`. Desktop source/package version is `0.2.0-beta.47`; it has not been published or installed into the real user profile. No production deployment or installed plugin update was performed. Before rollout, apply the additive Node migration, configure backend-only `OPENAI_API_KEY` and `SAYROVE_ENRICHMENT_MODEL`, publish the backend and package/reconnect the desktop plugin with updated schema/skill. Without provider configuration raw captures remain durably pending; this is not complete note generation.

No live provider key was available. Real enrichment output quality, completion time, API cost, and production desktop/cloud response times therefore remain unverified. See [deployment and worker details](../backend-node/ENRICHMENT.md).

Local install artifact: `dist/language-memory-0.2.0-beta.47-macos-arm64.zip` (30196542 bytes). SHA-256: `44c1c844f233cdabb3f952ab9228a0e3cf8e3961d2ba0f76f0bbfc333b508c78`. The archive contains the desktop plugin; the Node backend must be deployed separately.
