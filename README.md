# Codex Language Memory

A local language-learning memory for Codex. Keep learning in your existing conversation: ask about a word, compare grammar, translate an expression, or correct a sentence. Codex extracts useful learning points and saves them through a small SQLite-backed MCP server.

Recording is automatic for all languages and enabled by default on new installations. The optional local page lets you browse records and change preferences. It uses neutral colors, follows the system theme, and supports English, Chinese, Japanese, Korean, French, and Spanish.

## Install

Requires a local Codex desktop app or CLI and Python 3.10+. Tested with Python 3.12. Clone the repository, then run from its directory:

```sh
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements.txt
codex mcp add language_memory -- "$PWD/.venv/bin/python" "$PWD/server.py"
codex mcp get language_memory
```

The project skill is in `.agents/skills/language-memory`. To make it available across projects, link it into your user skill directory:

```sh
mkdir -p "$HOME/.agents/skills"
ln -s "$PWD/.agents/skills/language-memory" "$HOME/.agents/skills/language-memory"
```

If a skill or MCP server already exists under this name, inspect its location before replacing it. Open a new Codex conversation after installation. The CLI's `/mcp` command lists connected tools. Alternatively, adapt the absolute paths in [mcp.config.example.toml](mcp.config.example.toml) and merge it into your Codex configuration.

The database defaults to `~/.local/share/codex-language-memory/memory.sqlite3`, outside the repository. Set `LANGUAGE_MEMORY_DB` to an absolute path to override it. Use the same path for every session. Database files, local environments, secrets files, and logs are ignored by Git.

## Try it in Codex

Equivalent requests work in any language; these examples are in English:

1. `$language-memory Enable learning records.`
2. `What does approach mean in "The new approach worked"?`
3. In a new conversation: `Have I asked about approach before?`
4. `Quiz me on one of my English words.` Codex should ask first, wait for your answer, then explain and record the result.
5. `I know this now.` Or: `Delete that record`, `Pause recording`, `Is recording enabled?`
6. `Open the language learning page`, `Switch the interface to Spanish`, or `How many records do I have in each language?`

Automatic capture depends on Codex selecting the skill and calling tools. It can miss a point. Use `Remember this` or `Save the language points from this conversation` as explicit fallbacks. The integration does not listen to every message, scan chat history, or inject all records into every conversation. Records enter the current model context when Codex retrieves them.

MCP operations follow the client's approval policy. A rejected write is reported as unsuccessful. The skill only confirms a save after a successful tool result.

## Local page

Ask Codex to open the learning page. `open_memory_page` returns a local URL that Codex can open in its browser side panel when that capability is available. Otherwise, open the returned URL in a browser.

- Browse and search knowledge points, filtered by language, type, and mastery.
- Read meanings, explanations, examples, and the original learning context.
- Edit records, change mastery, and delete individual records.
- Change the recording switch, captured types, or interface language. Settings save immediately; there is no **Save settings** button.

Every language is eligible for capture. The language dropdown filters displayed records only. The interface language is independent of the language being learned and does not translate saved content. Language groups include regional variants, while each record keeps its actual language tag.

The server binds only to loopback and uses a random URL token. The page shares the MCP database. A page started by MCP stops with that MCP process; ask Codex to open it again if its URL expires. To run a standalone page against the same database:

```sh
.venv/bin/python dashboard.py
# Use an isolated database for development:
.venv/bin/python dashboard.py --db /absolute/path/to/test.sqlite3
```

## Capture decisions

Codex interprets the conversation; the tools handle deterministic storage. No additional model call or embedding service analyzes the chat.

| Request | What to capture |
| --- | --- |
| Ask what a word means here | That word's specific contextual meaning |
| Ask why one preposition or grammar form is used | The rule or usage contrast |
| Ask to correct your own sentence | Original, correction, and reason |
| Ask how to express something naturally while learning | A useful phrase or sentence-level expression |
| Translate an unrelated work document | No presumed vocabulary gaps; wait for learning intent or an explicit point |

Only necessary learning context is stored. A translation does not imply every word is unknown. A Japanese word explained in Chinese belongs to the Japanese group. Asking once or answering once does not imply mastery.

## Storage and tools

Each knowledge point has an ID, type, target language, title, stable sense key, meaning, optional context/explanation/correction/examples, creation and last-encounter timestamps, encounter count, mastery, and last review timestamp/result. Unused content fields are optional. The latest supplied context is retained when encounters merge.

| Tool | Purpose |
| --- | --- |
| `get_recording`, `set_recording` | Read or change the persistent recording switch |
| `get_settings`, `update_settings` | Read or patch `enabled`, `enabled_types`, and `ui_language` |
| `open_memory_page` | Start or retrieve the local page |
| `list_languages` | List language groups and record counts |
| `save_points` | Batch save with per-item added, merged, skipped, or failed outcomes |
| `find_points` | Search by keyword, type, language, and mastery; newest encounters first |
| `review_queue` | Exclude mastered points; unreviewed first, then oldest review |
| `update_point` | Edit content/mastery or record a review result |
| `delete_point` | Delete by ID |

Deduplication uses type, language, normalized title, and `sense_key`. Codex searches for a likely repeat and reuses its identity; paraphrased identities can still create semantic duplicates. Different meanings use separate sense keys.

A new encounter gets a new `request_id`. Retries reuse the same ID and exact parameters, so they cannot increment the count again. Saves and receipts commit in one SQLite transaction. Deleting a record leaves a content-free request hash and receipt so retrying the old save cannot recreate it. `source=automatic/explicit` describes a save's origin; it is not a recording-mode preference.

Paused recording blocks new saves, including explicit ones. Queries, review, edits, and deletion remain available. Type restrictions also apply to explicit saves. Upgrade compatibility ignores retired `capture_mode`, `target_language`, and `target_languages` preferences while preserving existing data, the recording switch, type selection, and UI language.

## Tests and verified boundaries

```sh
.venv/bin/python -m unittest discover -s tests -v
node --test tests/test_locales.mjs
```

The 19 Python tests use isolated databases and covers persistence, query filters, language separation, sense deduplication, partial batches, rollback, concurrent idempotent retries, deletion without resurrection, legacy preference migration, settings validation, local HTTP protections, pagination, and an MCP session restart with review/update/delete. The 2 Node tests check translation completeness and matching placeholders for all six UI locales.

A real Codex CLI conversation was tested against the local user's database: four learning questions produced one automatic `save_points` call with four successful additions, one each for English, Chinese, Japanese, and Korean. No explicit save request was included. These are local acceptance-test records; they are not shipped in the repository.

A separate Codex CLI session, without explicitly naming the skill, retrieved all four records and asked a Japanese question without showing its answer. The Codex browser was used to verify immediate settings writes, persistence after reload, sequential rapid changes, and the French and Spanish interfaces. Earlier CLI/App Server tests also verified a quiz, waiting for an answer, and writing the review result into an isolated database. Desktop skill discovery and write approvals should still be checked in your own installed client with the examples above; capture on every turn is not guaranteed.

Source identifiers, comments, documentation, and skill instructions are written in English. Localized UI strings and multilingual learning fixtures retain their original languages.

## Official references

- [Codex skills](https://learn.chatgpt.com/docs/build-skills)
- [Codex MCP configuration](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)
- [Codex hooks and their limits](https://learn.chatgpt.com/docs/hooks)
- [Plugin packaging](https://developers.openai.com/plugins/build/plugins)

This MVP uses a skill and local stdio MCP configuration. It does not require a hosted service, account system, native settings extension, chat UI, vector database, or review-generation service.
