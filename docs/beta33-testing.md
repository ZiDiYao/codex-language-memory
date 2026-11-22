# Beta 33: overlapping learning scenes

Verified on November 22, 2026, on the local Apple Silicon Mac.

## Behavior

- Scenes are an independent dimension alongside language and type. One record can belong to several scenes, and a scene can contain words, expressions, grammar and corrections.
- Codex uses the current meaning and context to assign reusable scene names during capture. Labels are open-ended; the three translated examples are Cleaning & hygiene, Device controls and Body reactions. A small conservative offline fallback supports legacy records and older clients. There is no additional AI service or background classification worker.
- The single history view adds one scene picker. Type and language filters combine with it. Expanded notes allow separate scene editing, with automatic saves and revision conflict protection.
- Export inherits the selected scene and type. Its scene picker follows export language and type choices; previews, receipts and downloads retain the same scope. A scene catalog failure cannot silently broaden an export.
- Manual assignments, including an empty list, survive subsequent captures and restarts. Scene edits do not add learning encounters, change note content or update FSRS state.

## Checks

- 141 Python tests passed, including overlapping counts, combined filters, semantic fallback boundaries, idempotency, manual assignment preservation, legacy migration, concurrent starts, word-sense consolidation and export scope.
- 26 Node tests passed, including scene parsing, mixed filters across pagination, editor conflict/draft protection, export inheritance and asynchronous scene catalog ownership.
- The browser module dependency graph is fetched through the real HTTP server. This catches missing static routes such as the new scene-model.js import.
- Scene names are normalized before their length is validated. Names longer than 80 normalized characters and editor separators inside a single name are rejected. Each record supports at most 12 names.
- The final frozen ZIP passed the isolated install/upgrade/rollback/uninstall/reinstall lifecycle, 24-tool discovery, app resource and bridge checks, scene and type filtering, invalid-name rejection, persistent study state and all five export formats. The test profile excludes Python and Node from PATH.
- A copy of the real beta.32 database retained every original column in all 15 original tables other than change-version counters. SQLite integrity and foreign-key checks passed. Isolated compatibility checks also exercised old beta.32 reads/writes and concurrent additive migrations.
- Actual browser checks used 12 temporary records, separate from personal learning data. Cleaning & hygiene showed both words and an expression; Word narrowed it to wipe, rub and rinse. Adding a scene to rub persisted after reload. Export inherited the scene and Word selection, and its preview contained exactly those three records. Screenshots are in dist/beta33-qa.

## Activation boundary

The managed local installation was upgraded from beta.32 to beta.33, with a database backup and a refreshed, enabled native plugin cache. A fresh installed-runtime MCP session exposed all 24 tools and the new app resource. Seven existing English notes were classified from their current content. All original fields in the ten records and all 15 original data tables remained unchanged; only scene fields and change-version counters were added or updated. Settings, SQLite integrity and foreign-key checks passed. The deployment report is in dist/beta33-qa/installed-verification.json.

The installer backs up the database and atomically switches the managed release, then refreshes the native plugin cache and bundled skill. Existing host-managed MCP processes may retain the older executable and tool schema. Restart or reconnect Codex and begin a new chat to use the updated native plugin. A fresh stdio session verifies the installed runtime separately; the running host is not killed as part of deployment.

Package validation uses an isolated profile on this Mac, not a separate clean Mac or a notarized download. Its previous-version lifecycle fixture shares the current executable; the real beta.32 database-copy and old-source compatibility checks cover the additional migration boundary.
