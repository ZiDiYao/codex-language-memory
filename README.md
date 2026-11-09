# Codex Language Memory

A local language-learning memory for Codex. Keep learning in your existing conversation: ask about a word, compare grammar, translate an expression, or correct a sentence. Codex extracts useful learning points and saves them through a small SQLite-backed MCP server.

Recording is automatic for all languages and enabled by default on new installations. The optional local page lets you browse records and change preferences. It uses neutral colors, follows the system theme, and supports English, Chinese, Japanese, Korean, French, and Spanish.

## Install the local Beta

Download the **Apple Silicon Mac** ZIP from [GitHub Releases](https://github.com/ZiDiYao/codex-language-memory/releases/tag/v0.2.0-beta.15), extract it, and double-click **Install.command**. Restart Codex and start a new conversation. No Python installation, API key or manual path configuration is needed. The downloaded folder can be deleted after installation.

To upgrade, download the next Beta and run its **Install.command**. The installer validates the package, tests its runtime, backs up the database and switches versions while preserving learning records and settings. Repeating the same installation is safe. It also migrates the earlier source-checkout installation automatically.

- **Check Installation.command**: inspect the installed version and connection.
- **Roll Back.command**: activate the previous packaged version while keeping current data.
- **Uninstall.command**: disconnect MCP and Skill; retain records, backups and release files for recovery.

The repository is currently private, so GitHub downloads require repository access. This Beta is not Apple Developer ID signed or notarized; macOS may require its normal Privacy & Security / Open Anyway confirmation. The installer never disables Gatekeeper. Tested on macOS 26.5.1 arm64; other binary targets and clean-machine downloaded-app validation remain outstanding.

Code is installed under `~/Library/Application Support/Codex Language Memory`. Data stays at `~/.local/share/codex-language-memory/memory.sqlite3` unless this integration already has a custom absolute database path. An existing `CODEX_HOME` is respected. Other Codex settings, servers and skills are preserved. See [installation, upgrade and recovery details](docs/beta-release.md).

This installer connects the local MCP server and Skill directly. It does not publish to or install from the official plugin directory. Portable plugin manifests are included for authoring; avoid registering a second copy through a marketplace.

For source development, Python 3.10+ is supported (tested with 3.12):

```sh
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements.txt
codex mcp add language_memory -- "$PWD/.venv/bin/python" "$PWD/server.py"
mkdir -p "$HOME/.agents/skills"
ln -s "$PWD/.agents/skills/language-memory" "$HOME/.agents/skills/language-memory"
```

The source instructions are an alternative to the Beta installer. Inspect an existing registration before replacing it. Database files, environments, credentials and release artifacts are ignored by Git. [Build and test the packaged Beta](docs/beta-release.md#building-and-checking-a-release) before distributing a new version.

## Try it in Codex

Equivalent requests work in any language; these examples are in English:

1. `$language-memory Enable learning records.`
2. `What does approach mean in "The new approach worked"?`
3. In a new conversation: `Have I asked about approach before?`
4. `Quiz me on one of my English words.` Codex should ask first, wait for your answer, then explain and record the result.
5. `I know this now.` Or: `Delete that record`, `Pause recording`, `Is recording enabled?`
6. `Open the language learning page`, `Switch the interface to Spanish`, or `How many records do I have in each language?`
7. `Export my English expressions to Word`, `Export all my records as PDF`, or `Prepare a Notion import`.
8. `Explain my Japanese grammar in Chinese, keep it brief, and use travel examples.` Then in another conversation: `Based on my learning history, what should I practice?`

Automatic capture depends on Codex selecting the skill and calling tools. It can miss a point. Use `Remember this` or `Save the language points from this conversation` as explicit fallbacks. The integration does not listen to every message, scan chat history, or inject all records into every conversation. Records enter the current model context when Codex retrieves them.

MCP operations follow the client's approval policy. A rejected write is reported as unsuccessful. The skill only confirms a save after a successful tool result.

## Local page

Ask Codex to open the learning page. `open_memory_page` returns a local URL that Codex can open in its browser side panel when that capability is available. Otherwise, open the returned URL in a browser.

- Select a language from the dropdown to see its recent learning history. Use **All**, **Word**, **Expression**, or **Grammar** to filter that history in place. **All** also includes correction records. There are no separate category or document pages.
- Expand a record into one freely editable note. Its initial text contains the captured title, meaning, explanation, context and examples. Change, add, reorder or remove any text; there are no required sections. The first nonempty line becomes the card title. Edits auto-save quietly after a short pause or on leaving the note. There is no permanent save notice. Failed saves show inline recovery controls; concurrent changes preserve the draft and show a conflict message. Editing does not add encounters or reviews.
- Choose **To Learn** or **Mastered** in the two-option control in a card header. The current state is highlighted; choosing a state does not open or close the note. The user decides whether they know it; no score or quiz is required. The page has no Delete button; deletion remains available through Codex when requested.
- Open **Settings** in the top-right corner to change recording, captured types, or interface language. English is the initial interface language. Settings save immediately.
- Scroll to load more records automatically. The visible page checks for database changes every three seconds and when focused. Active edits are preserved. There are no page numbers or Refresh button.
- **Export** starts with filters: language, one or more types, search, mastery, and dates. Choose all time, the last 7/30/90 calendar days, or a custom inclusive local date range, based on date added or last encountered. Then choose full notes, terms only, or selected captured sections, with optional learning metadata. Continue to the matching record count and file formats; Back preserves your choices. All matching records are included, even if not loaded on screen.

The current note is returned to Codex and used by full-note exports in every format, including JSON. Terms-only export uses the current note title. Selected-section export explicitly uses the structured fields captured by Codex (original title, meaning, explanation, examples and optional translations/context/correction); it does not parse later freeform note edits. This source distinction is shown in the dialog. Excluded fields are removed before rendering every format, including JSON and both Notion views. User edits, including empty notes, survive repeated encounters. Existing records are converted to note text on read without discarding their original data. Older Betas cannot display custom notes, but preserve them for a subsequent upgrade.

Expanded cards use a compact single-row header. Notes and previews share a flush-left edge, including fullwidth opening punctuation, without rewriting stored text. Expandable records, menus and dialogs use short transitions. System reduced-motion preferences disable movement. Search updates as you type; background synchronization preserves expanded records and active edits.

The language dropdown contains only languages with saved records. The first saved point adds its language; deleting the last point removes it. Language and type filters combine with search and apply to exports. Every language is eligible for capture, including languages outside the six interface translations. Regional variants share a group while records keep their exact tags. First-language and interface settings remain independent of these groups and do not translate saved content.

The server binds only to loopback and uses a random URL token. The page shares the MCP database. A page started by MCP stops with that MCP process; ask Codex to open it again if its URL expires. To run a standalone page against the same database:

```sh
.venv/bin/python dashboard.py
# Use an isolated database for development:
.venv/bin/python dashboard.py --db /absolute/path/to/test.sqlite3
```

## Export

The page and `export_points` tool support PDF, Excel (`.xlsx`), Word (`.docx`), a Notion import ZIP, and JSON for direct reading. Codex can also read records through `find_points` without generating a file. Tool exports are saved in an `exports` directory beside the database; browser exports download normally. No data is uploaded automatically.

The MCP request supports `content="notes"` (default), `content="terms"`, or `content="sections"` with `fields` such as `["meaning", "examples", "translations"]`. `translations` controls example translations and requires `examples`; `meaning` includes the captured definition/translation. Use `include_metadata=false` for a minimal file. `kinds` supports several types; use it instead of `kind`. `start_at` is inclusive and `end_at` exclusive, both timezone-aware ISO timestamps, with `date_field="created_at"` or `"last_seen_at"`. The page converts local calendar dates to UTC, including daylight-saving changes. Filters are read again at export time so deleted records are not silently included from a stale preview.

The Notion ZIP contains a Markdown page per record and a CSV table, as alternative import views. Follow [Notion's import instructions](https://www.notion.com/help/import-data-into-notion). This creates an import file, not a live Notion connection or published page.

PDF export embeds a local TrueType font that covers the exported characters. macOS Arial Unicode is detected automatically. On other systems, set `LANGUAGE_MEMORY_PDF_FONT` to an installed `.ttf` file covering the required languages. If no suitable font exists, export fails with a clear message instead of silently producing missing-glyph boxes. Word and Excel require suitable fonts in the application opening the document. No proprietary fonts are bundled.

## Guided study with Codex

Say “Help me study my saved English for five minutes” or “What should I practice today?” Codex resolves the learning language, reads your preferences, and starts a small round from the FSRS queue. The default is three points, one question at a time, using your current editable notes.

FSRS determines when a point is due. Codex uses its category, your last actual answer and explicit interests to choose a contextual vocabulary question, expression exercise, grammar contrast or sentence correction. It waits for your answer, explains the specific gap, and records the outcome. Hints and immediate practice after an explanation are assisted; reading an explanation alone is not a scored review. Your Mastered choice stays independent.

The queue includes selection reasons, the most recent attempt and counts before the batch limit. It excludes empty notes and can exclude IDs already practiced or skipped in the current round, so an unchanged assisted/skipped schedule does not create a loop. When nothing is due, a schedule-only question gets the schedule; an explicit request to practice now can select upcoming points and is identified as early practice. It finishes the agreed round and respects “Stop” immediately.

This uses the existing Skill and 16 MCP tools. There is no additional AI service, session database or chat UI. A new chat reconstructs the next round from persisted records and review evidence; it cannot recover an unsaved unfinished question. Skill activation is model-driven, and the extension does not send proactive messages while you are away.

## Capture decisions

Codex interprets the conversation and generates the contextual definition, explanation, and examples before saving. New captures require an explanation and two to five distinct example sentences. Codex adds common collocations or natural usage, a relevant pitfall when useful, and example translations in the preferred explanation language. Duplicate example originals are rejected. Saved notes omit routine source links and originality footers unless attribution is requested. The backend validates and stores that content; it does not make a second AI call. For older incomplete records, Codex can retrieve `needs_enrichment=true` records and fill a missing explanation or append examples through `update_point` without adding an encounter or changing mastery. Existing examples and user-edited notes are preserved; the quality checks do not restrict freely edited notes. The page itself does not run a background AI worker.

| Request | What to capture |
| --- | --- |
| Ask what a word means here | That word's specific contextual meaning |
| Ask why one preposition or grammar form is used | The rule or usage contrast |
| Ask to correct your own sentence | Original, correction, and reason |
| Ask how to express something naturally while learning | A useful phrase or sentence-level expression |
| Translate an unrelated work document | No presumed vocabulary gaps; wait for learning intent or an explicit point |

Only necessary learning context is stored. A translation does not imply every word is unknown. A Japanese word explained in Chinese belongs to the Japanese group. Asking once or answering once does not imply mastery.

## Storage and tools

Each knowledge point has an ID, type, target language, title, stable sense key, meaning, explanation, examples, optional context/correction, creation and last-encounter timestamps, encounter count, mastery, and last review timestamp/result. Mastery is `new` (To Learn) or `mastered` (Mastered). Legacy `learning` records migrate to `new`. Review results never automatically change mastery. Merged encounters keep the latest context on the record and preserve each new context separately in history.

FSRS-6 (`fsrs==6.3.2`) updates each point's memory state after actual unassisted recall, using default parameters and 90% desired retention. The review queue prioritizes overdue points, then unassessed points. Skipped or assisted attempts are preserved as evidence without changing the schedule; asking a question does not count as a failed quiz. Codex reads observed histories and explicit, language-specific teaching preferences to personalize explanations. No personal parameter fitting or overall proficiency scoring is claimed. See [the learning model and primary references](docs/learning-model.md) for rating semantics, uncertainty, evaluation and migration details.

| Tool | Purpose |
| --- | --- |
| `get_recording`, `set_recording` | Read or change the persistent recording switch |
| `get_settings`, `update_settings` | Read or patch `enabled`, `enabled_types`, and `ui_language` |
| `open_memory_page` | Start or retrieve the local page |
| `list_languages` | List language groups and record counts |
| `save_points` | Batch save with per-item added, merged, skipped, or failed outcomes |
| `find_points` | Search by keyword, type, language, mastery, or missing generated content; follow `next_cursor` for more |
| `review_queue` | Due FSRS points, then unassessed; current notes, latest attempts, scope counts, round exclusions and optional early practice |
| `record_review` | Record an actual quiz attempt idempotently and update FSRS when eligible |
| `get_point_history` | Read encounter contexts, quiz evidence and an explicitly uncalibrated memory estimate |
| `get_learning_profile` | Read language-scoped practice counts, recurring points and stated preferences |
| `update_learning_preferences` | Store or clear explicit explanation language/style, goal and example interests |
| `update_point` | Edit content or user-controlled mastery |
| `delete_point` | Delete by ID |
| `export_points` | Export all matching records locally as PDF, XLSX, DOCX, Notion ZIP, or JSON |

Deduplication uses type, language, normalized title, and `sense_key`. Codex searches for a likely repeat and reuses its identity; paraphrased identities can still create semantic duplicates. Different meanings use separate sense keys.

A new encounter gets a new `request_id`. Retries reuse the same ID and exact parameters, so they cannot increment the count again. Saves and receipts commit in one SQLite transaction. Deleting a record leaves a content-free request hash and receipt so retrying the old save cannot recreate it. `source=automatic/explicit` describes a save's origin; it is not a recording-mode preference.

Each quiz attempt also requires a fresh `request_id` through `record_review`. Repeat the same arguments and ID on retry. Legacy `update_point` patches containing `review_result` fail without making changes; migrate them to `record_review`. Existing latest-review summaries are preserved but do not fabricate past FSRS history. Deletion removes the point's encounters, review events and scheduler state together. Preference fields can be forgotten by setting them to null through `update_learning_preferences`.

Paused recording blocks new saves, including explicit ones. Queries, review, edits, and deletion remain available. Type restrictions also apply to explicit saves. Upgrade compatibility ignores retired `capture_mode`, `target_language`, and `target_languages` preferences while preserving existing data, the recording switch, type selection, and UI language.

## Tests and verified boundaries

```sh
.venv/bin/python -m pip install -r requirements-dev.txt
.venv/bin/python -m unittest discover -s tests -v
node --test tests/*.mjs
```

[Beta 15 guided-study results](docs/beta15-testing.md) cover a 25-step final conversation acceptance set, including targeted reruns for issues found during development. There are now 89 Python tests and five Node tests.

[Beta 14 acceptance results](docs/beta14-testing.md) cover 35 real Codex turns, five replays of model-generated saves through the installed runtime, 86 Python tests, five JavaScript tests, and the packaged installation lifecycle.

The Python tests use isolated databases and cover persistence, query filters, language separation, sense deduplication, partial batches, rollback, concurrent idempotent retries, deletion without resurrection, legacy preference migration, settings validation, local HTTP protections, cursor pagination under concurrent inserts, legacy mastery migration, generated-content requirements, cross-process change detection, complete filtered exports, multilingual Office/Notion content, literal spreadsheet formulas, PDF text/font errors, and an MCP session restart with review/update/delete/export. Learning-model checks cover exact scheduling agreement with upstream FSRS across successful and failed recalls, assisted/skipped attempts, review retries and rollback, chronological prediction scoring, history pagination, language-scoped preferences, deletion cascades, legacy history gaps and clock reversal. These verify software behavior, not educational effectiveness. Node tests check translation completeness and matching placeholders for all six UI locales, language selection, and inclusive local date ranges across daylight-saving changes. Export tests verify date/type filtering, preview counts, and field exclusion in all five formats.

A real Codex CLI conversation was tested against the local user's database: four learning questions produced one automatic `save_points` call with four successful additions, one each for English, Chinese, Japanese, and Korean. No explicit save request was included. These are local acceptance-test records; they are not shipped in the repository.

A separate Codex CLI session, without explicitly naming the skill, retrieved all four records and asked a Japanese question without showing its answer. The Codex browser was used to verify immediate settings writes, persistence after reload, sequential rapid changes, and the French and Spanish interfaces. Earlier CLI/App Server tests also verified a quiz, waiting for an answer, and writing the review result into an isolated database. A further isolated real Codex CLI session automatically captured a French expression with its definition, explanation, and example, then exported it to Word. Browser checks verified both mastery transitions, custom language menus, 65 unique records loaded by scrolling, and automatic synchronization after an MCP content update. PDF and Word samples containing English, Chinese, Japanese, and Korean were rendered and visually inspected. Excel and Notion exports were parsed to verify content and structure; actual Notion import has not been tested.

After upgrading, restart or reconnect the MCP server and open a new Codex conversation to load changed tool schemas and skill instructions. Desktop skill discovery and write approvals should still be checked in your own installed client with the examples above; capture on every turn is not guaranteed.

The FSRS integration was also exercised in real isolated Codex App Server conversations: explicit preferences persisted across chats, personalized questions withheld their answers, unassisted success advanced memory without changing mastery, assisted answers did not train the scheduler, and repeated meaning questions added encounters rather than failed reviews. A progress question retrieved the evidence and declined to infer an overall English level from one practiced sense. A fresh ordinary word lookup automatically loaded the saved teaching preferences. These are observed cases, not a guarantee of model behavior on every turn.

Source identifiers, comments, documentation, and skill instructions are written in English. Localized UI strings and multilingual learning fixtures retain their original languages.

## Official references

- [Codex skills](https://learn.chatgpt.com/docs/build-skills)
- [Codex MCP configuration](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)
- [Codex hooks and their limits](https://learn.chatgpt.com/docs/hooks)
- [Plugin packaging](https://developers.openai.com/plugins/build/plugins)

This MVP uses a skill and local stdio MCP configuration. It does not require a hosted service, account system, native settings extension, chat UI, vector database, or review-generation service.

### First language and explanations

Settings asks for the user's first language; it is never inferred from the interface
or target language. The UI still defaults to English. Definitions, grammar notes,
feedback and example translations use the confirmed first language by default.
The user can override the explanation language globally in Settings or per learning
language through Codex. Specific preferences take precedence over global ones.
Original expressions and examples stay in the language being studied.
Changing a preference does not instantly translate the library: Codex explains relevant
records in that language in conversation and rewrites stored content when requested.
User edits are preserved. The backend does not make a second AI request.

To add the installed Beta to the native Codex Plugins directory, double-click
**Connect Extension.command**. After its first successful connection, future installs
also refresh the native plugin. See [release operations](docs/beta-release.md).
