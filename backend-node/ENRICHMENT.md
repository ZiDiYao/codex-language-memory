# Lightweight capture and durable enrichment

`POST /v1/observations` and MCP `capture_points` accept the same envelope:

```json
{"request_id":"unique-request-id","source":"automatic","items":[{"kind":"word","language":"en","title":"celery","context":"芹菜的英文咋说"}]}
```

Each item requires `kind`, `language`, and `title`. `context` and
`corrected_sentence` are optional. Codex identifies only an actual learning gap;
it does not generate definitions, examples, translations, scenes or semantic keys
for this path. Keep the same request ID and exact payload after an uncertain
result. A later real encounter uses a fresh ID. Ordinary normalized targets are
deduplicated in the backend; ambiguous legacy nonword targets are rejected rather
than merged speculatively. Existing rich `save_points` and `/v1/captures` remain
supported. `get_settings`/`GET /v1/settings` advertise
`_capabilities.lightweight_capture=true` without adding it to persisted settings.

Acceptance commits a minimal point, actual encounter, receipt and durable job in
one transaction. Results remain `added`/`merged` with `enrichment_state=pending`;
this means the learning target is recorded, not that its generated note is ready.
Recording/type settings are enforced before acceptance. Paused recording creates
no job. Partial invalid batches are reported individually and replay idempotently.
An identical pending task for the same tenant and point is reused, while each
actual encounter keeps its own receipt and encounter count. Processing, completed
or failed tasks are not reused as a content cache: different snapshots or new
contexts may require another meaning. Changed context/correction schedules its own work.

## Configure and deploy

The production cloud service uses `backend-node/`. Apply `node src/migration.js`
before starting the new service. Additive Node migration
`0003_lightweight_capture` upgrades `0002_desktop_imports`; the shared Python base
Alembic revision stays `0001_remote_storage`. `/readyz` requires the current Node
extension tables and marker. Old Python-only CRUD remains compatible, but the
Python cloud server does not offer the new observation endpoint/capability.

Set these **on the backend service only**, in its secret/environment settings:

```sh
SAYROVE_ENRICHMENT_PROVIDER=deepseek
SAYROVE_ENRICHMENT_MODEL=deepseek-flash
DEEPSEEK_API_KEY=your-server-side-secret
```

DeepSeek is the default provider; `deepseek-flash` is its default model, and the
model name can be overridden without changing the worker. Never include provider
keys in Codex tool arguments, frontend configuration, logs or source files.
Empty/missing credentials leave the worker disabled with durable jobs pending.
The exact API shape and current model identifiers were verified against the
[DeepSeek Chat Completions reference](https://api-docs.deepseek.com/api/create-chat-completion/)
and [JSON Output guide](https://api-docs.deepseek.com/guides/json_mode/).
The adapter explicitly disables DeepSeek thinking, asks for JSON with a schema
and example, and rejects blank final content, truncation, refusal, tool output
and invalid JSON. Business validation of complete notes runs before commit.

Provider configuration is explicit:

| Provider | Protocol | Credential | Model | API root |
| --- | --- | --- | --- | --- |
| `deepseek` (default) | Chat Completions JSON | `DEEPSEEK_API_KEY` | `SAYROVE_ENRICHMENT_MODEL`, default `deepseek-flash` | Default `https://api.deepseek.com` |
| `openai` | Responses strict JSON Schema | `OPENAI_API_KEY` | Explicit `SAYROVE_ENRICHMENT_MODEL` | Default `https://api.openai.com/v1` |
| `openai-compatible` | Chat Completions JSON | `SAYROVE_ENRICHMENT_API_KEY` | Explicit `SAYROVE_ENRICHMENT_MODEL` | Required `SAYROVE_ENRICHMENT_BASE_URL` |

All providers support a server-configured `SAYROVE_ENRICHMENT_BASE_URL` override.
API roots must use HTTPS and cannot embed credentials, query strings or fragments.
Requests reject redirects. Credentials are selected only for the chosen vendor;
there is no automatic fallback to another vendor or reuse of another vendor's key.
Existing OpenAI deployments must now explicitly set `SAYROVE_ENRICHMENT_PROVIDER=openai`.
With no configured key/model, observations remain pending until configuration and
restart. `.env.example` and `compose.node.yaml` pass the selected backend settings;
the Python-only compose service does not implement this feature.

Adapters live under `src/providers/`. Their common contract is
`createEnricher({provider, apiKey, model, baseUrl?, fetchImpl?})`, returning an async
`(input, {signal}) => generatedNote` function, or `null` when unconfigured. The
frozen built-in registry holds factories; add a factory for another protocol
without editing queue, tenant isolation, capture APIs or note validation. Model
IDs are configuration rather than conditional branches. A newly registered vendor
can use the generic `SAYROVE_ENRICHMENT_API_KEY` setting unless its factory needs
additional explicit configuration. Providers share the learning-note schema and
instructions; each transport sends only fields it supports.

Codex remains the only learning-gap identifier. Providers receive the identified
target, minimal context, existing sense labels, relevant scene names and resolved
explanation language. They enrich that observation and never scan a whole chat or
infer extra unknown vocabulary. Missing explanation preferences fall back to the
target language, never an inferred first language. OpenAI sends `store:false`;
DeepSeek uses its own documented JSON transport without unsupported OpenAI fields.

No live DeepSeek or OpenAI key was available during implementation. Provider
transports and worker behavior were tested using deterministic fixtures plus an
isolated local PostgreSQL database; real output quality, completion time and API
cost have not been measured. Changing the background vendor does not establish
the separate <=20% foreground response-time target.

## Worker behavior

Jobs survive backend restarts in PostgreSQL. The in-process worker polls once per
second, claims a 60-second lease, and gives a provider request a 30-second deadline.
Claims, completion, edits and deletion consistently lock tenant before job rows.
Different workers cannot process the same live lease or simultaneous jobs for the
same point. Provider requests run outside database transactions. Expired leases
are reclaimed with new tokens; stale workers cannot commit. Failures retry with
exponential backoff (2^attempt seconds, capped at 300), at most four attempts.
Terminal failures are visible as `enrichment_state=failed`; captured raw data is
retained. New explicit encounters may schedule fresh jobs. There is no public
administrative retry endpoint in this change.

Queried records expose `pending`, `processing`, `failed` or `ready` state. Content
version changes invalidate existing `/v1/changes` polling after worker transitions.
Incomplete raw notes are excluded from quizzes. Enrichment changes no encounter
count, timestamps of actual encounters, mastery state, review results or FSRS
state. Same senses deduplicate; different observed meanings remain in one word
record. Generated content cannot rename the target or change kind/language.

Manual notes (including an explicitly emptied note), scene assignments and
concurrent content edits win over in-flight AI. Mastery and new encounter counters
do not invalidate content generation. Deleted points cascade-delete jobs and
cannot be recreated by late completion. Manual content changes encountered during
a job cause terminal `content_changed`; a fresh actual encounter can enrich the
current point if it has no custom note.

## Verification

Run with a disposable test database, never the production learning account:

```sh
TEST_DATABASE_URL=postgresql://... npm test
```

Integration tests create isolated schemas and cover auth, idempotency, tenant
isolation, recording/type filters, concurrent capture/claims, lease recovery,
retry bounds, manual edits, deletion, senses and legacy compatibility. See the
repository benchmark artifacts for measured foreground latency. Backend transport
measurements exclude Codex generation and external network latency.
