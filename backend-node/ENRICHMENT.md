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

## Configure and deploy

The production cloud service uses `backend-node/`. Apply `node src/migration.js`
before starting the new service. Additive Node migration
`0003_lightweight_capture` upgrades `0002_desktop_imports`; the shared Python base
Alembic revision stays `0001_remote_storage`. `/readyz` requires the current Node
extension tables and marker. Old Python-only CRUD remains compatible, but the
Python cloud server does not offer the new observation endpoint/capability.

Set these **on the backend service only**, in its secret/environment settings:

- `OPENAI_API_KEY`: OpenAI API credential. Never include this in Codex tool
  arguments, frontend configuration, logs or source files.
- `SAYROVE_ENRICHMENT_MODEL`: an explicit model supporting Responses structured
  output. No model or paid provider is selected implicitly.

Both are required. Without either value, startup logs
`enrichment_worker_disabled`; accepted observations remain durably pending. No
placeholder definition is treated as completed. Configuring both and restarting
the backend starts the worker and drains pending work. Deployment and provider
setup were not performed by the implementation tests. The tests use a deterministic
fake provider and an isolated local PostgreSQL service; no claim is made about
real provider quality or enrichment completion latency.

The provider sends the exact learning target, necessary context, existing sense
labels, scene names and resolved explanation language to the OpenAI Responses
API, with `store:false` and strict JSON Schema output. It does not send the whole
conversation or any account credential. Missing explanation preferences fall
back to the target language, never an inferred first language. Refusals,
incomplete responses, invalid content and API failures remain failed/retryable.
The existing knowledge-point validator validates generated content before commit.

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
