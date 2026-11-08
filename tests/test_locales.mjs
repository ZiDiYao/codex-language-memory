import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const source = await readFile(
  new URL("../web/i18n.js", import.meta.url),
  "utf8",
);
const { messages } = await import(
  "data:text/javascript;base64," + Buffer.from(source).toString("base64")
);

test("all six UI languages have complete messages and matching placeholders", () => {
  assert.deepEqual(Object.keys(messages).sort(), [
    "en",
    "es",
    "fr",
    "ja",
    "ko",
    "zh",
  ]);
  const keys = Object.keys(messages.en).sort();
  for (const translations of Object.values(messages)) {
    assert.deepEqual(Object.keys(translations).sort(), keys);
    for (const key of keys) {
      assert.ok(translations[key].trim());
      assert.deepEqual(
        [...translations[key].matchAll(/\{\w+\}/g)]
          .map((match) => match[0])
          .sort(),
        [...messages.en[key].matchAll(/\{\w+\}/g)]
          .map((match) => match[0])
          .sort(),
      );
    }
  }
});

test("static UI labels and placeholders all have translations", async () => {
  const html = await readFile(
    new URL("../web/index.html", import.meta.url),
    "utf8",
  );
  for (const match of html.matchAll(/data-(?:i18n|placeholder)="([^"]+)"/g)) {
    assert.ok(messages.en[match[1]], match[1]);
  }
});
