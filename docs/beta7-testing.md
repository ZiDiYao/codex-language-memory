# Beta 7 verification

Tested on macOS 26.5.1 arm64, 2026-11-08.

- 73 Python tests and 3 JavaScript tests passed, along with JavaScript syntax and Git whitespace checks.
- Browser checks used an isolated database. The expanded card header measured 50 CSS pixels. CJK opening punctuation aligned with the note's left edge without changing its text. No Delete button was present.
- Mouse and Space-key status toggles switched between To Learn and Mastered without expanding or collapsing the card. Keyboard focus remained on the toggle. Pending note edits saved before the status change, and the note and status persisted after reload. No browser console errors were reported.
- The frozen package passed clean-profile installation, repeated installation, upgrade, backup, restart, rollback, uninstall and reinstall while preserving unrelated Codex configuration. This lifecycle fixture uses the current executable under two package versions.
- The local native extension was upgraded to Beta 7. Codex discovered the enabled Skill and 16 MCP tools. A read-only comparison confirmed that all existing record and preference rows were preserved. The installed page was reopened and visually checked.

Deletion through an explicitly requested Codex tool call remains supported. Only the page's Delete control was removed. No schema or learning-model behavior changed in this release.

No new model-driven learning conversation was run for this UI change. This Mac Beta remains unsigned and unnotarized; a separate clean-Mac Gatekeeper installation has not been tested.
