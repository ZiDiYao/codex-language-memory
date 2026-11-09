/** Keep each language history separate and omit empty groups. */
export function languageSelection(counts, current = "") {
  const languages = Object.keys(counts).filter((code) => counts[code] > 0).sort();
  return {
    languages,
    value: languages.includes(current) ? current : languages.includes("en") ? "en" : languages[0] || "",
  };
}

/** Shorten only the card heading; the saved note keeps its complete text. */
export function compactTitle(title) {
  const words = title.trim().split(/\s+/u);
  return words.length > 5 ? `${words.slice(0, 5).join(" ")}…` : title;
}
