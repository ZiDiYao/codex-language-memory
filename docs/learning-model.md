# Evidence-based personalization

The plugin uses **FSRS-6 through `fsrs==6.3.2`**, maintained by Open Spaced Repetition. It uses the library's default parameters, 90% desired retention, default learning/relearning steps, and disabled interval fuzzing for reproducible local behavior. The scheduler runs locally without an LLM call or network request. The base package requires only `typing-extensions`; the optional machine-learning optimizer is not installed.

FSRS estimates a point's difficulty, memory stability and current recall probability. It is a memory scheduler, not a general language-proficiency or personality model. The implementation follows the upstream algorithm rather than an invented weighted “learner score”. Anki also offers FSRS; this Python integration is not the exact Anki Rust implementation.

## Evidence and interpretation

| Observation | Persisted evidence | Scheduling effect |
| --- | --- | --- |
| A question about a specific meaning or rule | Encounter with minimal context and timestamp | None; asking is not a failed recall |
| A later question about the same sense | Another encounter, merged identity | None; keep both contexts |
| Retry of the same save/review | Existing receipt | None |
| Fully correct, unassisted quiz answer | Review result and exercise context | Good by default |
| Fully correct and explicitly difficult/easy | Review plus user-reported effort | Hard/Easy respectively |
| Partly correct or incorrect, unassisted answer | Review result and exercise context | Again; Hard is a passing grade |
| An answer after a hint or answer reveal | Assisted review | No FSRS update |
| Skipped question | Skipped review | No FSRS update |
| “I know this” / “I forgot this” | User-controlled Mastered / To Learn | No invented quiz or recall rating |
| Explicit explanation preference | Global or exact-language preference | Codex adapts its teaching |

Mapping a partial open-ended answer to Again is a conservative product policy: a point should represent one testable meaning or use. Split unrelated objectives into separate points. If the question or response is ambiguous, Codex clarifies before writing a result. The algorithm cannot repair a mistaken model assessment or an ambiguous learning item.

Each accepted quiz attempt has a unique request ID. Evidence, FSRS state, the latest-review summary and the retry receipt commit in one SQLite transaction. Request-ID reuse with different content fails. Encounter writes have the same transactional guarantee. Deleting a point cascades to its encounters, reviews and memory state. Content-free receipts remain to prevent retries from recreating deleted information.

The queue excludes user-marked Mastered points and future reviews by default. It selects overdue scheduled points first (oldest due first), then unassessed points (oldest created first). Explicit early practice can include upcoming records. No background notifications or automatic questions are sent.

## What becomes personal

1. **Point-level memory:** actual answers update each point's stability, difficulty and due time independently. Languages and senses never share a card.
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
