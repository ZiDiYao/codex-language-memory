# Beta 34: local pronunciation

Verified November 22, 2026 on the local Apple Silicon Mac.

A compact speaker button reads the current note title using the target language's installed macOS voice. Clicking again stops playback; another record replaces the current speech. Playback state follows the child process, and voice or audio-service failures are reported. Learning text is passed through stdin to a fixed executable; no arbitrary command, filename or voice argument comes from the page. Speech control sequences are neutralized. No cloud speech service or API key is used.

The shared validated actions work in both the loopback page and native MCP App. No additional model-facing MCP tools or database migrations are introduced. Unsupported language voices show an error. The feature plays through the Mac's system audio output, rather than the browser tab's media controls.

Validation:

- 145 Python tests and 26 Node tests passed; the added tests cover same-record stop, current-note pronunciation, missing records, unsupported voices, process failures and unchanged learning evidence.
- Browser verification confirmed that clicking the speaker changes its pressed state, does not expand the note, and returns to idle after speech completes. The screenshot in dist/beta34-qa/pronunciation.jpg uses isolated test data.
- Samantha generated a valid WAV pronunciation sample for grudge.
- The frozen ZIP passed the isolated install, upgrade, rollback, uninstall and reinstall checks, including the speech action through the native bridge.
- The installed beta.34 runtime successfully started and completed pronunciation through its native app transport. All 16 database tables matched the pre-upgrade snapshot exactly; SQLite integrity and foreign-key checks passed. All 14 learning records were preserved.
- The managed runtime and native plugin cache were upgraded from beta.33 to beta.34, with the installer's database backup retained. Existing Codex processes require reconnection or restart to load the new UI and backend.

Detailed local logs and installation reports are in dist/beta34-qa. Tests ran on this Mac, rather than a separate clean machine or notarized download.
