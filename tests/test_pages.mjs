import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const source = await readFile(new URL("../web/page-model.js", import.meta.url), "utf8");
const { languageSelection, pageFromHash, codexPrompt, codexLink } = await import("data:text/javascript;base64," + Buffer.from(source).toString("base64"));

test("language navigation only exposes populated languages and collapses a single notebook", () => {
  assert.deepEqual(languageSelection({}), { languages: [], value: "", showPicker: false });
  assert.deepEqual(languageSelection({ en: 2, fr: 0 }), { languages: ["en"], value: "en", showPicker: false });
  assert.equal(languageSelection({ en: 2, fr: 1 }, "en").value, "en");
  assert.equal(languageSelection({ en: 2, fr: 1 }, "ja").value, "");
  assert.equal(languageSelection({ fr: 1 }, "en").value, "fr");
  assert.equal(languageSelection({ en: 2, fr: 1 }).showPicker, true);
});

test("document routes accept only valid record IDs and supported categories", () => {
  assert.deepEqual(pageFromHash("#point-42"), { type: "point", id: 42 });
  assert.deepEqual(pageFromHash("#collection-grammar"), { type: "collection", kind: "grammar" });
  for (const hash of ["", "#point-0", "#point--1", "#point-999999999999999999999", "#point-1<script>", "#collection-other"])
    assert.deepEqual(pageFromHash(hash), { type: "library" });
});

test("Codex handoff carries scoped tool instructions without an automatic-send parameter", () => {
  const question = "Explain & compare #1 / 日本語?";
  const prompt = codexPrompt({ type: "point", id: 12 }, {}, question);
  const link = new URL(codexLink(prompt));
  assert.equal(link.protocol, "codex:");
  assert.equal(link.hostname, "new");
  assert.deepEqual([...link.searchParams.keys()], ["prompt"]);
  assert.equal(link.searchParams.get("prompt"), prompt);
  assert.match(prompt, /record 12 with get_point_history/);
  assert.ok(prompt.includes(question));
  assert.ok(prompt.includes("Opening this page is not a new encounter"));
  const collection = codexPrompt({ type: "collection", kind: "word" }, { kind: "word", language: "fr" }, "");
  assert.match(collection, /find_points/);
  assert.match(collection, /"language":"fr"/);
  assert.ok(!collection.includes("record 12"));
});
