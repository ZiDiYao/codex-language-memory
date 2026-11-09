# Code structure and refactor verification

The November 8 refactor separates request routing, persistence and rendering
without changing the page layout, styles, animations, database schema or MCP tools.
It adds no dependencies.

## Responsibility boundaries

- `dashboard_actions.py` pairs each allowed page action with its strict argument
  model and operation. Both page transports call this dispatcher.
- `dashboard.py` owns HTTP headers, local access checks, static assets and server
  lifecycle. Its handler no longer lives inside `Dashboard.start`.
- `mcp_app.py` separates API requests, export creation and download acknowledgement.
  The native bridge still rejects deletion and exposes no arbitrary tool execution.
- `Store.save` coordinates a single write transaction. Its helpers handle receipt
  replay, item validation, deduplication, insertion and content-preserving merges.
  Helpers receive that transaction's connection; encounters and receipts cannot
  commit separately. Existing request fingerprints remain compatible.
- `release_runtime.py` separates command execution, extension refresh and output.
  The stdio server never prints installer summaries to the protocol stream.
- `web/record-feed.js` owns cursor pagination, request versions and loading/error
  state. `web/app.js` owns DOM rendering, scroll anchors and editor guards. Every
  multi-page refresh uses one filter snapshot. Late responses cannot overwrite a
  newer search or unsaved edits.

## Verification

`npm run build`, 119 Python tests, 17 Node tests and `git diff --check` passed locally.
The tests include persistence, rollback, concurrent idempotent saves, partial
batches, legacy receipts, custom-note preservation, validation, export delivery,
CLI errors, native MCP discovery, out-of-order searches, retry recovery and
multi-page refreshes. The runtime health check uses an isolated database and
loads all five export formats.

Browser checks used 47 temporary records, separate from personal learning data:
English/French and type filtering, debounced `mi` search, loading the next 20
records on scroll, note editing, mastery persistence after reload, export preview
and JSON download. No browser console errors were observed. Native MCP transport
was tested programmatically. The subsequent installed upgrade is documented in
[Beta 29 verification](beta29-testing.md).


Beta 30 adds `word_records.py` for word-sense consolidation and recovery-safe legacy
migration. It keeps encounter-based review priority separate from the FSRS adapter.
See [Beta 30 verification](beta30-testing.md). The frontend remains unchanged.
