# Beta 26: persistent guided study

## Delivered

Five MCP tools start/resume a round, persist its question and hint flag, atomically
submit an answer, and pause/finish. They use the existing SQLite database and FSRS
scheduler. The Skill distinguishes product-development requests from learning
requests and requires actual tool retrieval before claiming plugin-backed review.

No files under web/ or dashboard.py changed. No extra model service, account system
or chat UI was added.

## Verified

- 103 Python tests passed, including a real stdio MCP process restart between
  preparing a question and answering it.
- 7 Node tests passed; Skill frontmatter validation and git diff checks passed.
- Word, expression and grammar fixtures complete a three-point round without
  increasing encounter counts or changing user-controlled mastery.
- Concurrent retries commit one review event. The answer and round progress roll
  back together when an injected database failure interrupts the transaction.
- Hints survive pause/resume and cannot be reset by a later unassisted flag.
  Assisted and skipped answers do not train FSRS. Pausing creates no quiz event.
- Edited notes invalidate pending questions. Deleted, empty and mastered records
  are not used for the next question. Language/type filters and empty libraries
  are covered.
- The frozen Apple Silicon ZIP passed isolated install, repeated install, upgrade,
  runtime restart, rollback, uninstall/reinstall and data-preservation checks.
  Its pending question and hint flag survived an upgrade. Frozen MCP exposes all
  21 tools and accepts/replays a study answer without duplicating evidence.
- The installer initially rejected the package because its health check still
  expected 16 tools. This was corrected; the rebuilt package passed the lifecycle.

## Installed Beta verification

The user's native extension was upgraded to Beta 26. Its installed runtime exposes
21 tools, including the five study tools, and its installed Skill/workflow match
the source files. All eight personal records and existing preference, encounter,
review and memory-state tables match the pre-upgrade backup. No synthetic round
or answer was written to the personal library.

## Limits and client acceptance

The tests drive deterministic tools with synthetic learner answers in temporary
databases. They do not establish model grading quality or guarantee automatic Skill
activation. The package test runs in an isolated profile on the build Mac, not a
separate clean Mac. Its earlier-version fixture uses the same executable with old
metadata; it tests release switching rather than every historical runtime.

After reconnecting/restarting Codex and opening a new chat, ask to review saved
English for five minutes. Verify profile/session/question tool calls before the
first question; request a hint and pause; continue in another chat; answer and
verify one submit_study_answer call. Check that the hint-assisted attempt preserves
the FSRS schedule and that no synthetic review appears in the personal library.
