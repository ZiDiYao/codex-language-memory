# Beta 15: guided study with Codex

Verified on 2026-11-08 (America/Toronto), macOS 26.5.1 arm64.

## Interaction contract

A request such as “Help me study my saved English for five minutes” starts a small round in the existing Codex conversation. The Skill reads the learner's preferences and FSRS queue, asks one question, waits, explains the specific difficulty, and records the actual attempt. The default round covers three points. Explicit requests to explain, ask for a hint, skip or stop take precedence.

FSRS chooses review timing. Codex chooses teaching language, examples and exercises using the current note, its category, explicit interests and actual earlier answers. Those teaching choices are workflow rules, not a new scientifically validated adaptive-learning algorithm. Mastered remains user-controlled.

The integration follows the official [Skill and MCP division of responsibilities](https://developers.openai.com/plugins/build/skills): the Skill organizes the workflow and deterministic tools supply data and actions. The existing 16 tools and SQLite schema are retained. No extra model service is needed.

## Backend changes

`review_queue` now returns current study content, selection reasons, latest actual attempts, an `as_of` timestamp, and full-scope counts before the result limit. `exclude_ids` omits points already practiced or skipped during the current round. This prevents assisted/skipped attempts, whose schedules remain unchanged, from repeatedly occupying the next question. Counts, latest attempts and records share one read snapshot.

Empty custom notes, including whitespace-only notes, are excluded alongside Mastered records. Counts and `next_due_at` obey the same language, type and exclusion filters. Historical attempts are evidence; they never override a user-edited note.

A schedule-only query does not begin a quiz. An explicit request to practice now can select upcoming material when nothing is due, identifying it as early practice without requiring another permission step. New chats rebuild a round from saved evidence; unfinished questions are not claimed to persist.

## Real conversation verification

Tests used real Codex App Server conversations with `gpt-6.1-sol` and the configured `ultra` reasoning. The only active MCP tools were this integration's tools, directed to isolated test databases. Fixtures reused language content generated in the Beta 14 acceptance tests and deliberately set up due, unassessed, upcoming, empty and multilingual cases. No personal library was used for the test lessons.

The final acceptance set contains **25 passing conversation steps**: seven guided-round/resumption steps, eight unchanged boundary steps, and ten final targeted regression steps. Superseded attempts remain in local evidence; they are not counted as passing final acceptance steps. Checks compared actual calls and database snapshots, and responses were read for question withholding, meaningful feedback, language choice, continuation and stopping.

| Scenario | Verified outcome |
| --- | --- |
| Three-point guided English round | Due grammar selected first, followed by vocabulary and an expression; one question at a time |
| Wrong grammar answer | Specific clause-versus-phrase feedback, one scored failure, then the next point |
| Vocabulary hint | Limited hint, no review before an answer; later success recorded as assisted |
| Independent expression answer | One scored success; no automatic Mastered change |
| Round completion | Brief evidence-based recap; no fourth question appended |
| New chat resumption | Retrieves preferences and recent failures, selects the due grammar point, uses a new travel scenario |
| Grammar transfer | A fresh correct rewrite advances its schedule without changing encounters or mastery |
| Schedule-only question | Reports actual queue information without beginning a lesson |
| Explicit study request with only upcoming material | Clearly identified early practice begins without another permission step |
| Stop before answering | No review, failed answer or skipped event invented |
| Read/explain saved notes | No new encounters or scored reviews |
| Immediate practice after teaching | Chinese word request, Chinese grammar request and English word request all record assisted success; schedules remain unchanged even with new example sentences |
| Empty note | Remains empty and is excluded from lessons |
| Several observed languages | Asks the learning language before selecting a lesson |
| Japanese grammar choice | Uses the Japanese record and the confirmed explanation language |
| Skip | Records an unscored skip and excludes its ID from refill; does not issue the same question again |

## Problems found and corrected

- An initial no-due lesson paused to request early-practice permission and quoted internal Skill instructions. The workflow now distinguishes schedule queries from explicit requests to study now. The latter already authorizes practice.
- One immediate post-explanation answer was incorrectly labeled independent recall. The rule now appears in both the core Skill and `record_review` description, explicitly covering a changed example sentence. All three final teaching-to-practice variants passed.
- Explaining an existing grammar note added an encounter in an intermediate run. The core Skill and save-tool description now distinguish going over saved material from a new spontaneous learning encounter. Final word and grammar explanation variants left encounter counts unchanged.
- A schedule query attempted `limit=100`, was rejected by the existing 50-item bound, and recovered. The tool description now states that bound and explains that full-scope counts do not require loading more records. The final schedule query used valid calls.

## Deterministic, package and installation checks

- **89 Python tests** and **five Node tests** passed. New coverage checks queue counts before limits, due ordering, regional-language/type scope, latest assisted/skipped attempts, round exclusions, current custom notes, whitespace-only notes, Mastered filtering and deletion.
- The frozen package passed its install/reinstall/upgrade/backup/restart/rollback/uninstall lifecycle, 16-tool inventory, multilingual persistence and all five export formats. New frozen-MCP checks verify latest-attempt retrieval and round exclusions. The upgrade fixture uses the current executable under two package versions.
- Skill validation and Git whitespace checks passed.

## Limits

The model still classifies intent and answers, and must choose the Skill and tools. These observed tests do not guarantee perfect classification or activation on every future turn. The memory scheduler is deterministic once given a review result; FSRS still uses population parameters and does not claim a calibrated language-proficiency assessment.

The real conversations ran through App Server. Native plugin discovery and installed-runtime preservation are checked separately. No background messaging, full chat-history monitoring, clean-Mac Gatekeeper verification or notarization is claimed. Test databases and raw transcripts remain outside the repository.
