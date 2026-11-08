# Beta 6 verification

Tested on macOS 26.5.1 arm64, 2026-11-08.

- 73 Python tests and 3 JavaScript tests passed. JavaScript syntax, Skill validation and Git whitespace checks passed.
- The note tests cover additive legacy migration, exact Unicode/newline preservation, cross-connection persistence, search, deletion, optimistic edit conflicts, empty notes, repeat-capture/retry preservation, full-length HTTP requests and all five export formats.
- Browser checks in an isolated database covered one editable note per expanded entry, autosave, reload persistence, empty notes, title/preview updates, mastery changes, note search and conflict recovery. A failed save blocked filter changes and preserved the draft. No browser console errors were reported.
- The frozen package passed clean-profile installation, repeated installation, upgrade, backup, restart, rollback, uninstall and reinstall with unrelated Codex configuration preserved. The standard lifecycle fixture uses the current executable under two package versions.
- An additional compatibility check used the actual Beta 5 and Beta 6 frozen executables: Beta 5 created the legacy database; Beta 6 preserved every original row and added a custom note; Beta 5 could still read, change mastery and merge a new encounter; Beta 6 then recovered the same custom note and review history.
- The installed native extension was updated to Beta 6. Codex app-server discovered its enabled Skill and 16 MCP tools. A read-only MCP check confirmed the existing records, history and preferences were preserved. The installed page was opened and visually checked with the single note editor.

The current note is authoritative for the page and human-readable exports. JSON also includes original structured capture fields used for identity and deduplication. Older Betas display these original fields, not custom notes, but retain the custom notes for a subsequent upgrade.

No new model-driven learning conversation was run for this UI change. Tool behavior and native discovery were tested directly. A newly started Codex conversation loads the updated Skill. This release remains unsigned and unnotarized; a separate clean-Mac Gatekeeper installation has not been tested.
