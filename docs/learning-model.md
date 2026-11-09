# Evidence-based personalization

The plugin uses **FSRS-6 through `fsrs==6.3.2`**, maintained by Open Spaced Repetition. It uses the library's default parameters, 90% desired retention, default learning/relearning steps, and disabled interval fuzzing for reproducible local behavior. The scheduler runs locally without an LLM call or network request. The base package requires only `typing-extensions`; the optional machine-learning optimizer is not installed.

FSRS estimates a point's difficulty, memory stability and current recall probability. It is a memory scheduler, not a general language-proficiency or personality model. The implementation follows the upstream algorithm rather than an invented weighted “learner score”. Anki also offers FSRS; this Python integration is not the exact Anki Rust implementation.

## Evidence and interpretation

| Observation | Persisted evidence | Scheduling effect |
| --- | --- | --- |
| A question about a specific meaning or rule | Encounter with minimal context and timestamp | None; asking is not a failed recall |
| A later question about a saved word or point | Another encounter, merged identity | Increase review priority and surface the record; no FSRS rating |
| Retry of the same save/review | Existing receipt | None |
| Fully correct, unassisted quiz answer | Review result and exercise context | Good by default |
| Fully correct and explicitly difficult/easy | Review plus user-reported effort | Hard/Easy respectively |
| Partly correct or incorrect, unassisted answer | Review result and exercise context | Again; Hard is a passing grade |
| An answer after a hint or answer reveal | Assisted review | No FSRS update |
| Skipped question | Skipped review | No FSRS update |
| “I know this” / “I forgot this” | User-controlled Mastered / To Learn | No invented quiz or recall rating |
| Explicit explanation preference | Global or exact-language preference | Codex adapts its teaching |

Mapping a partial open-ended answer to Again is a conservative product policy: each question should test one clear meaning or use. A word note may contain multiple meanings, so the saved prompt must identify which meaning was tested. If the question or response is ambiguous, Codex clarifies before writing a result. The algorithm cannot repair a mistaken model assessment or an ambiguous learning item.

Each accepted quiz attempt has a unique request ID. Evidence, FSRS state, the latest-review summary and the retry receipt commit in one SQLite transaction. Request-ID reuse with different content fails. Encounter writes have the same transactional guarantee. Deleting a point cascades to its encounters, reviews and memory state. Content-free receipts remain to prevent retries from recreating deleted information.

The queue excludes user-marked Mastered points and empty notes. Repeated questions come first, ordered by `repeat_priority`: each fresh repeat adds one, while multiple meanings captured in the same request add at most one. This can select a point before its FSRS due date. An unassisted correct answer clears the extra priority; failures, partial answers, assistance, skipped attempts and retries do not. This is a transparent product selection rule, not an FSRS parameter or a validated proficiency score. It never fabricates quiz evidence or changes FSRS intervals. Remaining records use overdue scheduled order, then unassessed order. Other future reviews require explicit early practice. No background notifications or automatic questions are sent.

## What becomes personal

1. **Point-level memory:** actual answers update each point's stability, difficulty and due time independently. Languages never share a card. Meanings of the same word now share one word-level card and note; this scheduler therefore cannot measure mastery of each meaning separately. Codex tests a relevant meaning in context and does not generalize one answer to all meanings.
2. **Observed history:** Codex can retrieve earlier contexts, recent mistakes and repeated questions, with counts and source evidence. This supports contextual explanations and targeted exercises.
3. **Explicit teaching preferences:** explanation language, concise/detailed explanations, a learning goal and example interests. Exact language preferences override global preferences. They can be changed or cleared conversationally.

The profile exposes raw counts and specific recurring points, not an unsupported overall ability score. A one-off question is not evidence of a broad weakness. The model's uncertainty is explicit: unassessed points have no recall estimate, estimates are marked uncalibrated, and the profile reports `personal_parameters_trained=false`.

## Evaluation and future fitting

Every scored review after the first stores the prediction made **before** observing that response. The profile reports the number of these predictions and their mean Brier score (mean squared probability error against correct/unsuccessful retrieval). Assisted and skipped answers are excluded. This is descriptive, chronological evaluation on observed practice, not independent proof of learning gains or general proficiency; repeated practice and user-selected exercises introduce selection effects.

No per-user parameter fitting or Bayesian knowledge tracing is implemented in this release. Start with defaults while collecting genuine, diverse review history. Anki documents that a small number of reviews can limit FSRS performance. Adding a fitter later requires sufficient chronological data per language, held-out comparison against defaults (Brier score/log loss and calibration), and a fallback when fitted parameters do not improve predictions. Do not promise that estimates necessarily improve after every event.

Duolingo's half-life regression is another published approach to recall prediction. Its fitted model and linguistic features are useful research references, but this plugin has neither Duolingo's training population nor its structured exercises. Importing a formula would not import that validation. FSRS's maintained local implementation is the smaller first integration.

## Migration and boundaries

Existing points, mastery choices, encounter counts and latest-review summaries are preserved. New history begins at upgrade. Past encounters are reported as `encounters_without_history`; the plugin does not invent missing contexts or reconstruct complete review sequences from the last summary. Legacy `update_point` review patches now fail with `use_record_review_with_request_id`; use `record_review` instead. Content and mastery updates remain compatible.

The page continues to expose only To Learn and Mastered. The richer evidence and scheduling are available to Codex through tools, with no additional dashboard or required user forms. Capture still depends on Codex selecting the skill and calling tools; this is not a listener for every message or all chat history. Local quiz results and preferences are not uploaded.

## Primary references

- [FSRS algorithm and DSR model](https://github.com/open-spaced-repetition/awesome-fsrs/wiki/The-Algorithm)
- [Py-FSRS package, API and optimizer](https://github.com/open-spaced-repetition/py-fsrs)
- [Anki FSRS documentation, rating semantics and optimization limitations](https://docs.ankiweb.net/manual/deck-options#fsrs)
- [Settles and Meeder, A Trainable Spaced Repetition Model for Language Learning, ACL 2016](https://aclanthology.org/P16-1174/)

## Word consolidation (Beta 30)

Old same-language, same-title word records merge in one transaction on upgrade. The earliest ID survives; meanings, examples, contexts, reviews and custom text are retained. A shared request counts as one encounter. Historical counts without contexts are retained without fabricating evidence. Old IDs resolve to the surviving record, including retry receipts; deletion cannot resurrect it. Pending study rounds drop duplicate word slots while keeping completed answers. When two existing schedules merge, the latest independently rated record supplies the continuing FSRS state; schedules are not averaged or retrained. Source record/state snapshots remain locally in `merged_words` until the surviving word is deleted. The installer also makes a full database backup. Older Beta runtimes cannot add a separate sense card after this migration; restart Codex to use Beta 30.
