# Activity heatmap

The heatmap combines real word/expression encounters (70%) with real page
interactions (30%). Neither reading the heatmap nor clicking the app creates a
learning encounter. No additional model/tool call is added to conversation
capture. Historical learning counts come directly from retained `lm_encounters`
joined to their `word`/`expression` points. Grammar/corrections are excluded;
missing or deleted history and old UI activity are never invented.

`GET /v1/activity?timezone=America%2FToronto` uses the existing verified REST
principal and required scopes. `timezone` defaults to `UTC`, is validated as a
supported IANA name and canonicalized, and is passed as a SQL parameter. The
response contains 182 calendar dates, ascending, ending today in that timezone.
DST days retain their actual local boundaries, including repeated hours.

Optional `year=2024` instead returns every calendar date from January 1 through
December 31 (365 or 366 entries). Years must be integers from 1970 through the
current year in the requested timezone; future years are rejected. Omitting
`year` retains the original 182-day range. Responses additionally contain:

- `year`: the requested integer, or `null` for the legacy 182-day range.
- `today`: the current date in the requested timezone. Dates after `today` have
  zero counts/score/level and should be displayed as future, disabled cells.
- `available_years`: descending years from the timezone's current year through
  this tenant's earliest retained word/expression encounter or accepted UI
  interaction, with a lower bound of 1970. No data yields only the current year.
  Empty intervening years are selectable without inventing history. This list
  is a display hint, not an authorization range: earlier legal empty years can
  still be queried and return genuine zeros.

Only the earliest qualifying timestamp from each existing date index is read
for year choices; aggregation remains bounded to the selected calendar year or
the legacy 182-day range, and never reads days after `today`. No migration,
backfill or additional conversational/MCP tool is required.

```json
{
  "timezone": "America/Toronto",
  "start_date": "2026-05-27",
  "end_date": "2026-11-24",
  "weights": {"learning": 0.7, "interaction": 0.3},
  "targets": {"learning": 5, "interaction": 10},
  "days": [{"date": "2026-05-27", "learning_count": 0,
    "interaction_count": 0, "score": 0, "level": 0}],
  "totals": {"learning_count": 0, "interaction_count": 0,
    "active_days": 0, "score": 0}
}
```

The abbreviated `days` example above represents a full 182-element array,
including zero days. For each day:

`score = round(70 × min(learning_count/5, 1) + 30 × min(interaction_count/10, 1))`

`level` is zero for score zero, otherwise `ceil(score/25)` (1–4). Counts remain
the actual counts even after the score saturates. `totals.score` sums daily
scores; it is not a percentage. `active_days` counts nonzero-score dates.

`POST /v1/activity/events` accepts only the following shape (1–20 events,
8-KiB body limit):

```json
{"events":[{"event_id":"5c8a62cd-8b67-4fe6-9f10-b69041cf9d72",
  "kind":"button","occurred_at":"2026-11-24T15:00:00.000Z"}]}
```

Kinds are `button` and `pronunciation`. Emit pronunciation for a user's actual
listen click, never for a timer, automatic playback/retry or backend synthesis.
Do not double-emit a pronunciation button as a generic button. Events contain
no note IDs, titles, URLs, content, client identifiers or provider credentials.
The server binds the tenant from authentication. Extra fields are rejected.

New event timestamps must be within the previous five minutes and no more than
60 seconds ahead of server time. Accepted UUIDs are unique per tenant and
idempotent on retry, even once their timestamp is older than five minutes.
Server-side limits accept one event per kind per five-second occurrence-time
bucket and at most 200 accepted events per UTC receipt day. Consequently,
batching clicks from different intervals preserves the same counts as sending
them individually. Rapid repeated clicks in a bucket are discarded, rather than
inflating the score. Only accepted events are persisted. Rejected throttled
events have no receipt and should not be retried after a successful response.

```json
{"status":"ok","accepted":2,"duplicate":1,"throttled":3}
```

The three counts account for every submitted event. Network retries must reuse
the same UUIDs and timestamps. UI submission should be asynchronous and bounded;
it must not block a learning answer or a page action. Capture-off settings do
not fabricate or erase retained encounter history.

Migration `0004_activity_events` adds the separate minimal UI event table and
date indexes, retaining the shared Python Alembic head `0001_remote_storage`.
Node migrations upgrade existing `0002`/`0003` extensions transactionally and
reject unknown or incomplete heads. There is no UI-event backfill and no change
to saved notes, encounters, mastery or reviews. Settings advertise
`_capabilities.activity=true` only on this compatible backend.

Tests use isolated fixture data/JWTs and disposable PostgreSQL schemas. They
exercise DST, actual encounter filtering, replay/cooldown/caps, batching,
concurrency, tenant isolation, validation/CORS and additive migrations without
using production accounts or paid models.
