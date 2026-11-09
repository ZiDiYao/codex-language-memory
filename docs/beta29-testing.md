# Beta 29: refactored runtime upgrade

Beta 29 packages the request-routing, transactional-save and frontend-loading
refactor described in [code structure](code-structure.md). No UI redesign or
database schema change is included.

## Package verification

- The Apple Silicon archive was rebuilt with the bundled runtime; no frozen code
  from Beta 28 was reused.
- All 13 packaged lifecycle checks passed: installation, repeated installation,
  upgrade, process restart, rollback, uninstall/reinstall and unrelated settings
  preservation. The suite also exercises multilingual saves, idempotent reviews,
  note editing and conflicts, guided study, and all five export formats.
- The frozen MCP App resource and its app-only bridge work without developer
  Python or Node on PATH. All 23 tools are discoverable.
- Layout, stylesheet, animations, pickers, editor, export dialog, calendar and
  translations match the installed Beta 28 files byte for byte.

## Installed upgrade verification

The actual Beta 28 installation was upgraded to Beta 29 and its native plugin
registration refreshed. The installer retained Beta 28 for rollback and created
a private SQLite backup before migration.

All 15 database tables and the schema matched their pre-upgrade fingerprints.
The comparison includes records, settings, encounters, receipts, learning
preferences, FSRS state and study progress. Personal records were not edited for QA.

A fresh process launched through the installed extension verified settings,
ranked search, the review queue, the native resource, the app-only transport and
the new frontend module. The existing browser tab was switched to that process.
Browser checks verified `mi` search ranking, note expansion, grammar filtering
and retained language settings. No page console errors were observed.

## Boundaries

The current Codex chat retained its older MCP process after registration changed.
Restart Codex to load the new tools in existing chats. The opened loopback page
already runs Beta 29. Native resource/transport checks used a fresh installed
process; they are not evidence that an already-open native panel hot-reloaded.

The package lifecycle fixture uses the current executable with older metadata;
the actual personal upgrade provides a separate Beta 28-to-29 preservation check.
Testing ran on the build Mac, not a separate clean Mac or a notarized download.
