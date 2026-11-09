# Beta 30: repeated words and review priority

## Behavior

- One normalized word title per exact target-language tag. Captured meanings and
  examples share its note; expressions and grammar retain their existing identities.
- Each new learning encounter updates recent-history order and adds one unit of
  repeat priority. Multiple meanings in one request count once; retries do not
  change counts, priority or timestamps.
- Repeated questions are selected before ordinary scheduled and new material,
  including when the word is not yet due. A correct unassisted answer clears the
  extra priority. This is a product queue rule; FSRS ratings and intervals still
  change only after actual unassisted retrieval. Mastered and empty notes are excluded.
- Existing same-word cards consolidate on upgrade, retaining captured content,
  custom notes, unique encounters and reviews. Old IDs remain usable for lookup,
  edits, exports and exclusions. Original source/state snapshots are stored locally.
  Retry receipts prevent deleted records from being recreated.
- The Skill and tool descriptions now distinguish repeat capture from reading or
  practicing saved notes. Inflected forms depend on Codex reusing the saved title;
  deterministic normalization does not claim semantic equivalence across spellings.

## Verification

- 129 Python tests passed, including ten new word/priority tests: multi-meaning
  batches, independent repeats, concurrent retries, language separation, custom
  edits, all-sense exports, scheduled future eligibility, priority clearing,
  migration rollback, old-ID compatibility, review history and latest rated state.
- 17 JavaScript tests passed; the native MCP App builds successfully.
- The frozen Apple Silicon package passed all 14 lifecycle checks using isolated
  data, including real stdio save/query/review calls, grouped meanings and priority,
  restart, all five exports, upgrade, rollback and reinstall.
- The actual installed Beta upgraded from 29 to 30 with a database backup. Its
  11 records became 10 solely by combining the two credential cards. Both meanings,
  explanations and every example were retained. Other records, preferences, review
  events, study sessions and receipts were compared with the backup and unchanged.
  SQLite integrity and foreign-key checks passed. Test encounters were not added
  to the personal database.
- A fresh installed MCP process exposed 23 tools, served the native App resource,
  and successfully queried the merged word and settings through the App bridge.
- Browser verification showed exactly one credential card. Expanding it showed
  the qualification and authentication definitions and their original examples.
- All 16 packaged frontend assets are byte-for-byte identical to Beta 29. No
  layout, styling, animations, controls or UI text changed.
- Skill validation and git diff whitespace checks passed.

## Limits

The packaged lifecycle upgrade fixture shares the current executable with older
metadata; it is not a historical-runtime compatibility test. The separate actual
29-to-30 upgrade provides real migration coverage. An older already-running MCP
process does not reload Python code or its Skill: restart Codex to activate the
new capture rules in existing client sessions. Testing was on the build Mac,
not a clean notarized-download installation. Protocol and browser tests do not
prove that Codex will select the Skill on every future language question.
