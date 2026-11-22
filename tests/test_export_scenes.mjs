import assert from "node:assert/strict";
import { test } from "node:test";

globalThis.matchMedia ??= () => ({ matches: true, addEventListener() {}, removeEventListener() {} });
const { ExportDialog } = await import("../web/export-dialog.js");

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function fixture(api, current = { language: "en", kind: "word", scene: "Cleaning & hygiene" }) {
  const dialog = Object.create(ExportDialog.prototype);
  const calls = [], feedback = [], steps = [];
  const nodes = new Map();
  const node = (id) => {
    if (!nodes.has(id)) nodes.set(id, { disabled: false, textContent: "", reset() {} });
    return nodes.get(id);
  };
  const picker = (value = "") => ({ value, button: {}, setValue(value) { this.value = value; }, setOptions(options) { this.options = options; }, setLabel() {} });
  Object.assign(dialog, {
    root: { open: false, dataset: {}, showModal() { this.open = true; }, querySelector: node },
    pick: node, pickers: { language: picker(), status: picker(), scene: picker() },
    sceneCatalog: [], sceneVersion: 0, generation: 0, kinds: new Set(),
    dates: { from: "", through: "", reset() {}, close() {} },
    t: (key) => key, getFilters: () => current, flushEditors: async () => true,
    errorKey: (error) => error.message,
    feedback: (...args) => feedback.push(args),
    api: (action, args) => { calls.push({ action, args }); return api(action, args); },
    renderHistory() {}, relabel() { this.renderScenes(); }, renderPreview() {},
    showStep(formats) { steps.push(formats); },
  });
  return { dialog, calls, feedback, steps, nodes };
}

test("export inherits the viewed scene and keeps it in history, preview and prepared download filters", async () => {
  const { dialog, calls, steps } = fixture(async (action) => action === "scenes/list"
    ? { scenes: [{ name: "Cleaning & hygiene", count: 2 }] }
    : action === "exports/preview" ? { count: 2, titles: ["rinse", "rub"] } : { last_export: null });
  await dialog.open();
  assert.equal(dialog.pickers.scene.value, "Cleaning & hygiene");
  await dialog.next();
  assert.equal(calls.find(({ action }) => action === "exports/history").args.scene, "Cleaning & hygiene");
  assert.equal(calls.find(({ action }) => action === "exports/preview").args.scene, "Cleaning & hygiene");
  assert.equal(dialog.prepared.scene, "Cleaning & hygiene");
  assert.deepEqual(dialog.prepared.kinds, ["word"]);
  assert.deepEqual(steps, [false, true]);
  dialog.pickers.scene.setValue("");
  assert.equal(dialog.selection().scene, null);
});

test("export combines scene choices from multiple types and clears only scenes outside the new scope", async () => {
  const { dialog } = fixture(async (_, { kind }) => ({ scenes: kind === "word"
    ? [{ name: "Body reactions", count: 2 }]
    : [{ name: "Body reactions", count: 1 }, { name: "Device controls", count: 3 }] }));
  dialog.kinds = new Set(["word", "expression"]);
  dialog.pickers.scene.value = "Body reactions";
  await dialog.loadScenes();
  assert.deepEqual(dialog.sceneCatalog, [{ name: "Body reactions", count: 3 }, { name: "Device controls", count: 3 }]);
  assert.equal(dialog.pickers.scene.value, "Body reactions");
  dialog.kinds = new Set(["word"]);
  dialog.pickers.scene.value = "Device controls";
  await dialog.loadScenes();
  assert.equal(dialog.pickers.scene.value, "");
});

test("a late scene response cannot clear a newer export selection or its loading state", async () => {
  const old = deferred(), latest = deferred();
  const { dialog } = fixture((_, { language }) => language === "en" ? old.promise : latest.promise);
  dialog.pickers.language.value = "en";
  const first = dialog.loadScenes();
  dialog.pickers.language.value = "fr";
  dialog.pickers.scene.value = "At the bakery";
  const second = dialog.loadScenes();
  old.resolve({ scenes: [{ name: "Cleaning & hygiene", count: 2 }] });
  assert.equal(await first, false);
  assert.equal(dialog.sceneLoading, true);
  assert.equal(dialog.pickers.scene.value, "At the bakery");
  latest.resolve({ scenes: [{ name: "At the bakery", count: 1 }] });
  assert.equal(await second, true);
  assert.equal(dialog.sceneLoading, false);
  assert.equal(dialog.pickers.scene.value, "At the bakery");
});

test("a failed scene lookup preserves the inherited filter and cannot silently export the whole library", async () => {
  const { dialog, calls, feedback, steps } = fixture(async () => { throw new Error("unavailable"); });
  await dialog.open();
  assert.equal(dialog.pickers.scene.value, "Cleaning & hygiene");
  assert.ok(dialog.sceneLoadError);
  await dialog.next();
  assert.ok(calls.every(({ action }) => action === "scenes/list"));
  assert.deepEqual(steps, [false]);
  assert.ok(feedback.length >= 1);
});
