# Local Beta installation and release operations

The downloadable Beta targets Apple Silicon Macs. It includes a Python 3.12 runtime
and dependencies in a PyInstaller one-folder bundle. Users need Codex but do not
need Python, pip, Git, an API key, administrator privileges or hand-written paths.
The installer does not download dependencies or run a background updater.

## User workflow

Download and extract the ZIP from GitHub Releases, then double-click **Install.command**.
The same command installs, updates or repairs a release. Restart Codex and open a new
conversation to load the installed MCP tools and Skill. The extracted download can
then be removed; the installed copy is independent of it and the source repository.

For a later Beta, download its ZIP and run its Install.command. **Check Installation.command**
shows the installed version and registration state. **Roll Back.command** activates the
previous packaged release. **Uninstall.command** removes this integration's MCP registration
and Skill link, retaining records, backups and release files. Reinstall to reconnect.
No action restores an old database automatically or silently deletes learning data.

The repository is currently private: downloading from its Releases page requires
repository access. A downloaded ZIP can be distributed to authorized Beta testers
without giving them GitHub credentials or embedding any credentials in the package.

## Signing boundary

This Beta is ad-hoc signed by the packaging tool, not signed with an Apple Developer ID
and not notarized. A downloaded command or runtime may be blocked by Gatekeeper. The
release instructions describe Apple's normal Open Anyway flow; no script strips
quarantine attributes or disables system security. A notarized installer requires
the publisher's Apple Developer credentials and remains future release work.

The packaged workflow is tested in isolated profiles on macOS 26.5.1 arm64. This is
not certification on another clean Mac or proof of Gatekeeper first-open behavior.
Intel Mac, Windows and Linux binary packages are not included in this Beta.

## Installation state and data

- Code: `~/Library/Application Support/Codex Language Memory/releases/<version>-<digest>/`.
- Active code: an atomic `current` symbolic link. Old releases remain available to
  already running processes and to explicit rollback.
- Codex: one `mcp_servers.language_memory` entry in its user `config.toml`.
  A configured `CODEX_HOME` is respected. Unrelated settings and comments are preserved.
- Skill: `~/.agents/skills/language-memory` points to the installed release through `current`.
- Data: `~/.local/share/codex-language-memory/memory.sqlite3`, or the existing absolute
  `LANGUAGE_MEMORY_DB` from this integration's MCP configuration.
- Database backups: `backups/` beside the database, with private file permissions.
- Configuration backups: the install directory's `backups/`, also private.

The installer recognizes the original source-checkout MCP configuration and Skill
symlink. It adopts them without changing the database location, language settings,
capture switch, learning preferences, review history or FSRS state. It preserves
existing MCP enable/disable and tool restrictions. Unrelated servers or skills with
the same name cause a clear error instead of being overwritten.

Install/update uses a process lock, verifies the release manifest, checks the new
runtime and migrations against a SQLite backup copy, creates a persistent database
backup, and only then switches code and registration. Registration failures restore
the previous links/configuration when safe. Concurrent configuration edits are detected
instead of overwritten. A data backup is never restored automatically, because another
Codex process might have saved new learning records in the meantime. Current Beta
migrations are additive; a future incompatible schema needs an explicit migration policy.

The release checksum detects corruption. It is not a publisher signature. Installation
must start from a trusted release, and a checksum copied from that same source is not
independent authentication. Only package files are copied; developer databases, secrets,
Codex credentials, logs and virtual environments are excluded.

The default installer connects MCP and Skill directly. To show the Beta in Codex's
native Plugins directory, run **Connect Extension.command** after installation.
It uses the installed Codex CLI to add a personal local marketplace and verifies
that `language-memory@language-memory-local` is installed and enabled before removing
the duplicate direct MCP and Skill registration. No public listing is created.
The plugin points at the managed `current` runtime and the same database.

Once connected, future Install.command and Roll Back.command runs refresh the native
plugin's cached Skill automatically. If refresh fails, the direct MCP installation
remains a usable fallback and the command reports the failure. Run Connect Extension.command
to retry. Uninstall.command removes the native registration as well as the direct
connection, retaining learning data. Native registration requires an installed Codex CLI (detected automatically);
the default direct installation still needs no CLI. Restart Codex and start a new chat
after connecting or updating. Existing chats may retain their original tools.

## Building and checking a release

On an Apple Silicon Mac, from the source checkout:

```sh
python3.12 -m venv .venv
.venv/bin/python -m pip install -r requirements-build.txt -r requirements-dev.txt
.venv/bin/python -m unittest discover -s tests -v
node --test tests/*.mjs
.venv/bin/python scripts/build_beta.py
.venv/bin/python scripts/test_beta.py dist/language-memory-0.2.0-beta.25-macos-arm64.zip
```

Change `VERSION` for the next Beta. The builder copies that version into the packaged
manifest, collects third-party license notices, bundles the runtime and assets, writes
`release.json`, and creates the ZIP with `ditto` to preserve framework symlinks and modes.
`dist/SHA256SUMS.txt` contains the archive checksum. Build outputs are ignored by Git.
Do not use `--skip-freeze` after changing Python code; it is only for repackaging assets.

`scripts/test_beta.py` extracts the actual archive and executes its command files in a
temporary profile whose paths contain spaces. Runtime PATH excludes developer tools.
It tests fresh/repeated installation, real MCP calls, all five exports, persistent
settings/reviews, upgrade while the previous server is still readable, rollback,
uninstall and reinstall. Its older-release fixture changes package metadata while
using the same executable; source-to-Beta migration and failure paths have separate
installer tests. CI runs the Python and locale checks on pushes and pull requests;
the native bundle test must also run on the build Mac before uploading a release.

For diagnostics, the bundled executable supports `status --json`. The hidden
`--sandbox-root` option redirects installation, configuration, Skill and default data
paths to an isolated test profile; it does not change HOME or CODEX_HOME.

After tests pass, create a GitHub prerelease for the matching commit and upload the
ZIP, SHA256SUMS.txt and test report. Keep release visibility consistent with repository
visibility. GitHub credentials and Apple signing credentials are never bundled.

## References

- [Codex local MCP configuration](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)
- [Portable plugin packaging](https://developers.openai.com/plugins/build/plugins)
- [Desktop-only plugin distribution](https://developers.openai.com/plugins/deploy/desktop-only)
- [PyInstaller runtime paths](https://pyinstaller.org/en/stable/runtime-information.html)
