/** Keep each language history separate and omit empty groups. */
export function languageSelection(counts, current = "") {
  const languages = Object.keys(counts).filter((code) => counts[code] > 0).sort();
  return {
    languages,
    value: languages.includes(current) ? current : languages.includes("en") ? "en" : languages[0] || "",
  };
}
