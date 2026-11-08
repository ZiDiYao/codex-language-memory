import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const source = await readFile(new URL("../web/history-model.js", import.meta.url), "utf8");
const { languageSelection } = await import("data:text/javascript;base64," + Buffer.from(source).toString("base64"));

test("only observed languages appear, and the history always selects one language", () => {
  assert.deepEqual(languageSelection({}), { languages: [], value: "" });
  assert.deepEqual(languageSelection({ en: 2, fr: 0 }), { languages: ["en"], value: "en" });
  assert.equal(languageSelection({ en: 2, zh: 1 }).value, "en");
  assert.equal(languageSelection({ en: 2, zh: 1 }, "zh").value, "zh");
  assert.equal(languageSelection({ fr: 1 }, "en").value, "fr");
  assert.equal(languageSelection({ ja: 1, ko: 2 }, "fr").value, "ja");
});
