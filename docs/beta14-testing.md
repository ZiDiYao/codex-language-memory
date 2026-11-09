# Beta 14 acceptance results

Tested on 2026-11-08 (America/Toronto), macOS 26.5.1 arm64.

This release removes unsolicited dictionary/source links and example-originality footers from the default saved-note instructions. Requested citations remain possible. It does not change the database schema, UI or memory algorithm.

## Real Codex conversations

35 turns passed their behavioral checks across separate ephemeral Codex App Server conversations. The model was the configured `gpt-6.1-sol`, with `ultra` reasoning. Prompts asked ordinary learning questions without explicitly invoking the Skill or instructing the model to call tools. Explicit settings, editing and review requests were included where those were the behavior under test.

The conversations used two isolated SQLite databases. The only active MCP tools were the 16 language-memory tools pointed at those databases; the user's native plugin and other MCP integrations were disabled in the test processes only. The Skill was discovered from the checkout. No learning records were prewritten: Codex generated every captured point. Only a confirmed Chinese first-language preference was supplied as fixture setup.

Checks compared actual tool arguments/results and durable database state before and after each turn. Generated content and final responses were also read for the intended meaning, classification, example quality, explanation language and answer withholding. These are observed acceptance cases, not a linguistic benchmark or a guarantee of capture on every future turn.

| Turns | Scenario | Observed result |
| --- | --- | --- |
| 01–02 | Bare `serendipity` lookup; contextual noun `approach` | One requested word/sense captured each time |
| 03 | `resilient` and `despite` versus `although` in one lesson | One word and one grammar point; no incidental vocabulary captured |
| 04 | Correct `He go to school every day` | Original sentence, corrected sentence and error reason preserved |
| 05 | Translate for speaking practice | One useful sentence-level expression, not a word-by-word vocabulary list |
| 06–08 | Work-email translation, ordinary chat, explicit opt-out | No learning records added or changed |
| 09 | Chinese contrast, Japanese particles, Korean expression, French expression, Spanish grammar | Five separately tagged target languages with Chinese explanations and two or more distinct examples per record |
| 10–12 | Verb `approach`, repeated noun sense, cross-chat recall | Different meanings stay separate; repeat adds one encounter; recall returns both senses without writing |
| 13–14 | Ask a quiz, then answer | Question withheld the answer and did not write a review; the answer produced one correct, assisted review because the user had named the meaning in the request |
| 15–16 | User marks learned, then forgotten | Mastered and To Learn follow the user's choice |
| 17–20 | Pause, resume, explicit save after automatic save, delete | Paused question not captured; resume captures; same-turn explicit save does not double-count; deletion removes only the intended point |
| 21–22 | `on the fence`; `look forward to seeing` versus `see` | Expression and grammar classified and explained separately |
| 23–25 | Expression quiz, thinking aloud, wrong answer | No answer leaked with the question; thinking aloud not scored; wrong answer records one incorrect review without another encounter |
| 26–27 | Explicit save while paused; resume with `take it with a grain of salt` | Pause applies even to explicit saves; resume captures the expression |
| 28–29 | Replace a note with two user-authored lines; read in a new chat | Exact edited text retained and retrieved, without restoring historical capture fields |
| 30–31 | French first-language learner studying Chinese, then a new chat | Confirmed French preference persists; Chinese targets have French meanings, explanations and example translations |
| 32–33 | Empty a note, then request a quiz on it | Record retained; note stays empty; model declines to quiz from removed content |
| 34–35 | Fresh translation quiz followed by an unassisted correct answer | One scored review advances scheduling; encounter count and mastery do not change |

Every newly captured record had at least two distinct original example sentences. None contained the unwanted dictionary URL or originality footer. The empty/custom-note cases intentionally remained free of generated-content requirements.

## Deterministic and packaged checks

- 86 Python tests passed, including persistence, same-sense deduplication, distinct senses, concurrent save/review retries, partial failures, settings, queries, deletion without resurrection, custom-note conflicts, scheduling and exports.
- Five Node tests passed, covering localization, observed-language choices and date ranges including daylight-saving boundaries. Skill validation and Git whitespace checks passed.
- Five actual model-generated save requests were replayed through the installed frozen runtime against the isolated test database: word, word-plus-grammar batch, expression, multilingual batch, and a subsequently deleted record. All returned replay receipts; every database table was unchanged, including encounter counts and the deleted record's absence.
- The frozen Beta ZIP passed fresh and repeated installation, upgrade and backup, MCP restart, explicit rollback, uninstall/reinstall, unrelated-configuration preservation, all five export formats, and filtered export field exclusion. The lifecycle fixture uses the current executable under two package versions.
- The local native extension was upgraded. Codex discovered its enabled Beta 14 Skill and 16 tools. The real library retained four records. Comparison against the pre-edit backup showed only the requested note text changed; preferences, encounters, reviews and memory state were unchanged.
- The installed page displayed the cleaned note with its existing examples and had no browser console errors.

## Scope and remaining limits

These tests exercise the real model and MCP transport through App Server, plus native plugin discovery and the installed page. They are not a full replay of every case through the desktop chat UI. Automatic capture still requires Codex to choose the Skill and call tools. Explicit “Remember this” remains available when it misses a point.

No new learning effectiveness study, personal FSRS parameter training, real Notion import, clean-device Gatekeeper test or notarization was performed. Private learning data, raw tool transcripts and authentication configuration are not included in the repository or release.
