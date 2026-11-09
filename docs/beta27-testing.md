# Beta 27: native sidebar app

## Change

The `open_memory_app` tool declares an OpenAI global UI entrypoint and serves a
self-contained `text/html;profile=mcp-app` resource. The page uses the official
MCP Apps SDK and an app-only tool to communicate with the existing local database.
The original loopback page remains available. No cloud backend or extra model
call is added. Node is needed only to build from source, not to use the Beta.

The original HTML body, CSS, animations, editor, filters, pickers and export
dialog are reused unchanged. Only request/download transport changes. Export
receipts are acknowledged after delivery; cancelled native downloads do not
advance the receipt. The sandbox-download fallback retains the existing browser
delivery semantics and cannot confirm that a user kept the file on disk.

## Automated verification

- 107 Python tests and 10 JavaScript tests passed.
- Real stdio MCP discovery preserves the global entrypoint metadata, app-only
  visibility, MIME type and self-contained resource contents.
- Resource checks compare the original HTML body and full stylesheet byte for
  byte, confirming that the new container does not introduce a new layout.
- The bridge reads/searches the same database, persists settings and notes,
  respects optimistic edit revisions and does not add learning encounters.
- Unknown actions, oversized requests, invalid preferences and arbitrary routes
  are rejected. App transport does not accept filesystem paths or arbitrary tools.
- PDF, XLSX, DOCX, Notion ZIP and JSON export bytes pass through the bridge.
  Native download acknowledgement and cancellation are covered with a mock host.
- The extracted Apple Silicon package passed install, repeated install, upgrade,
  process restart, rollback and uninstall/reinstall in an isolated profile.
  The runtime serves its native UI without Node or Python on PATH.

## Installed client verification

Beta 27 was installed into the user's existing native extension. The installed
runtime exposes 23 tools. A fresh Codex app-server discovers the global entrypoint,
icons and UI resource without metadata loss. All eight personal records and all
existing database tables matched the pre-upgrade backup.

The user initially reported no visible entry, then reported finding it after
the client reconnected. The agent cannot control Codex's main navigation through
Computer Use, so the sidebar click itself is user-reported, not agent-observed.

The agent invoked the installed `open_memory_app` tool in the actual Codex client
and inspected the resulting native MCP App surface (not a localhost browser tab).
It rendered the existing English history, searched `mi` with `mitigate` first,
expanded the editable note, and displayed the existing English interface and
Chinese first-language preference. The personal data was not edited for QA.

A separate sandboxed browser test host exercised first-language autosave,
mastery changes and freeform note editing against a temporary database. These
write tests must not be described as personal-library edits or native-client
download tests.

## Remaining boundaries

Sidebar discovery and pinning are host-controlled and may require reconnecting
or restarting after an upgrade. Finding an entry is not proof of universal
marketplace availability. Native-client export saving was not manually tested;
its transport and binary output were tested separately as described above.
No automatic learning-capture or quiz-grading claim follows from this UI test.

References: [Plugin extensions](https://developers.openai.com/plugins/build/extensions)
and [MCP App UI](https://developers.openai.com/plugins/build/chatgpt-ui).
