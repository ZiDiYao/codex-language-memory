# Beta 3 verification

Version: `0.2.0-beta.3`, tested on an Apple Silicon Mac on November 8, 2026.

## Automated checks

- 67 Python tests pass, including SQLite persistence, deduplication, retry idempotency, search, deletion, review state, preferences, export formats and installation.
- New document tests verify persisted edits, atomic revision conflicts between simultaneous writers, unchanged encounter/review evidence, no resurrection after deletion, exact record export scope, and observed language/category groups.
- 5 JavaScript tests pass, covering all six UI translations, safe page routes, zero/one/multiple language navigation, and encoded, scoped Codex prompts.
- The Skill validator and `git diff --check` pass.
- The frozen ZIP passes the isolated install, repeated install, upgrade, restart, rollback, uninstall and reinstall lifecycle. It exposes 16 MCP tools and serves the new document assets. Revision conflicts and a single-record export are exercised through the frozen MCP server.

## Browser checks

An isolated test database was used for writes. No sample records were added to the personal library.

- Two words open on one editable Words page.
- An explanation saves on blur and survives a browser reload.
- An added example and translation persist when leaving the page.
- A concurrent backend edit produces an inline conflict; the local draft remains visible. Explicit reload retrieves the newer saved content.
- With one learning language, the selector is hidden. Adding the first French record makes the selector appear automatically; it contains only English and French.
- A category containing 26 records initially loads 20 and appends the remaining 6 when scrolled to the bottom.
- Single-point navigation and the Ask Codex dialog work. The link contains the point ID and the typed question, without an automatic-send parameter.
- No browser console warnings or errors were observed during these checks. The installed build's document page was also opened and visually inspected.

## Installation and remaining boundaries

The existing local installation was upgraded to Beta 3. Existing knowledge, encounters, reviews, memory state, save receipts and preferences match the pre-upgrade database backup. The native Codex plugin is enabled; the Codex app-server discovers its Skill and 16 tools.

The browser automation security policy blocked the `codex://new` navigation. Link construction was verified against the official command documentation, but the OS/client handoff still requires a manual click in the user's client. Copy prompt is available. No AI conversation was sent automatically.

The lifecycle test runs in an isolated profile on the build Mac, not on a separate clean device. The ZIP remains an unsigned local Beta; clean-device Gatekeeper behavior is not verified. A running older Codex process may retain the previous MCP schema until Codex is restarted and a new chat is opened.
