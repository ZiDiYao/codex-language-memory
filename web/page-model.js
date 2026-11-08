export const kinds = ["word", "expression", "grammar", "correction"];

export function languageSelection(counts, current = "") {
  const languages = Object.keys(counts).filter((code) => counts[code] > 0).sort();
  return {
    languages,
    value: languages.length === 1 ? languages[0] : languages.includes(current) ? current : "",
    showPicker: languages.length > 1,
  };
}

export function pageFromHash(hash) {
  const point = /^#point-([1-9]\d*)$/.exec(hash);
  if (point && Number.isSafeInteger(Number(point[1]))) return { type: "point", id: Number(point[1]) };
  const collection = /^#collection-(word|expression|grammar|correction)$/.exec(hash);
  return collection ? { type: "collection", kind: collection[1] } : { type: "library" };
}

export function codexPrompt(page, filters, question) {
  const context = page.type === "point"
    ? `Read my language-memory record ${page.id} with get_point_history before answering.`
    : `Read my language-memory points with find_points using these filters: ${JSON.stringify(filters)}. Follow next_cursor if more records are relevant.`;
  return `[@Language memory](plugin://language-memory@language-memory-local) ${context} Use my stored explanation-language preferences. Opening this page is not a new encounter. ${question.trim() || "Help me understand these learning points."}`;
}

export function codexLink(prompt) {
  return "codex://new?prompt=" + encodeURIComponent(prompt);
}
