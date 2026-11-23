/** Keep each language history separate and omit empty groups. */
export function languageSelection(counts, current = "") {
  const languages = Object.keys(counts).filter((code) => counts[code] > 0).sort();
  return {
    languages,
    value: languages.includes(current) ? current : languages.includes("en") ? "en" : languages[0] || "",
  };
}

/** Note preparation is separate from the learner's own mastery choice. */
export function enrichmentSummary(record) {
  const state = record.enrichment_state;
  const pending = state === "pending" || state === "processing";
  const failed = state === "failed";
  return {
    title: record.note_title || (!record.note_is_custom && (pending || failed) ? record.title : ""),
    messageKey: pending ? "enrichmentPending" : failed ? "enrichmentFailed" : null,
  };
}
