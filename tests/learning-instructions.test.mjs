import assert from "node:assert/strict";
import test from "node:test";
import { LearningInstructionsDraft, normalizeLearningInstructions, validLearningInstructions } from "../web/learning-instructions.js";
import { messages } from "../web/i18n.js";

const settings = (text = "", supported = true) => ({ english_learning_instructions: text,
  _capabilities: { custom_learning_instructions: supported }, first_language: "zh", enabled: true });
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test("a guidance draft is blank by default, saves only on request and survives preference reloads", async () => {
  const writes = [];
  const draft = new LearningInstructionsDraft({ save: async (patch) => { writes.push(patch); return settings(patch.english_learning_instructions); } });
  draft.load(settings());
  assert.equal(draft.value, "");
  draft.edit("  Use work examples.  ");
  draft.load({ ...settings(), ui_language: "fr" });
  assert.equal(draft.value, "  Use work examples.  ");
  assert.deepEqual(writes, []);
  assert.equal(await draft.save(), true);
  assert.deepEqual(writes, [{ english_learning_instructions: "Use work examples." }]);
  assert.equal(draft.value, "Use work examples.");
  assert.equal(draft.message, "learningInstructionsSaved");
  assert.equal(draft.dirty, false);
});

test("saving failures or an old service that ignores the field never report a saved draft", async () => {
  for (const write of [async () => { throw new Error("offline"); }, async () => ({ enabled: true }), async () => settings("different")]) {
    const draft = new LearningInstructionsDraft({ save: write });
    draft.load(settings("Earlier guidance"));
    draft.edit("New guidance");
    assert.equal(await draft.save(), false);
    assert.equal(draft.value, "New guidance");
    assert.equal(draft.confirmed, "Earlier guidance");
    assert.equal(draft.message, "learningInstructionsSaveFailed");
    assert.equal(draft.dirty, true);
  }
});

test("typing during a save keeps the newer draft and account-change flush saves it next", async () => {
  const first = deferred(), calls = [];
  const draft = new LearningInstructionsDraft({ save: (patch) => {
    calls.push(patch);
    return calls.length === 1 ? first.promise : Promise.resolve(settings(patch.english_learning_instructions));
  } });
  draft.load(settings());
  draft.edit("First version");
  const saving = draft.save();
  await Promise.resolve();
  draft.edit("Second version");
  const flushing = draft.flush();
  // app.renderSettings can observe the confirmed first save before save() settles.
  draft.load(settings("First version"));
  first.resolve(settings("First version"));
  assert.equal(await saving, true);
  assert.equal(await flushing, true);
  assert.deepEqual(calls.map((patch) => patch.english_learning_instructions), ["First version", "Second version"]);
  assert.equal(draft.value, "Second version");
  assert.equal(draft.confirmed, "Second version");
});

test("clearing guidance persists an empty string and keeps unrelated preferences outside its patch", async () => {
  const calls = [];
  const draft = new LearningInstructionsDraft({ save: async (patch) => { calls.push(patch); return settings(""); } });
  draft.load(settings("Use everyday examples."));
  assert.equal(await draft.clear(), true);
  assert.deepEqual(calls, [{ english_learning_instructions: "" }]);
  assert.equal(draft.confirmed, "");
  assert.equal(draft.dirty, false);
});

test("old-account saves cannot repopulate a cleared editor or alter a new account", async () => {
  const old = deferred();
  const draft = new LearningInstructionsDraft({ save: () => old.promise });
  draft.load(settings("Account A private guidance"));
  draft.edit("Account A private draft");
  const saving = draft.save();
  await Promise.resolve();
  draft.invalidate();
  assert.equal(draft.value, "");
  assert.equal(draft.available, false);
  draft.load(settings("Account B guidance"));
  old.resolve(settings("Account A private draft"));
  assert.equal(await saving, false);
  assert.equal(draft.value, "Account B guidance");
  assert.equal(draft.confirmed, "Account B guidance");
  assert.equal(draft.pending, null);
  assert.notEqual(draft.message, "learningInstructionsSaved");
});

test("unsupported services and invalid drafts do not submit, while Unicode limits count characters", async () => {
  let calls = 0;
  const draft = new LearningInstructionsDraft({ save: async () => { ++calls; return settings(); } });
  draft.load({ enabled: true });
  assert.equal(draft.available, false);
  draft.edit("Custom guidance");
  assert.equal(await draft.save(), false);
  assert.equal(draft.message, "learningInstructionsUnavailable");
  draft.load(settings());
  for (const value of ["x".repeat(1501), "bad\0text", "bad\ud800text", "bad\udffftext"]) {
    draft.edit(value);
    assert.equal(await draft.flush(), false);
    assert.equal(draft.message, "learningInstructionsInvalid");
  }
  assert.equal(calls, 0);
  assert.equal(validLearningInstructions("😀".repeat(1500)), true);
  assert.equal(validLearningInstructions("😀".repeat(1501)), false);
});

test("submission normalization agrees with service whitespace boundaries without stripping BOM", async () => {
  const prefix = "\u0085\u001c\u001d\u001e\u001f\t\n\u3000", text = prefix + "Use travel examples." + prefix;
  assert.equal(normalizeLearningInstructions(text), "Use travel examples.");
  assert.equal(normalizeLearningInstructions("\ufeffTest\ufeff"), "\ufeffTest\ufeff");
  const calls = [];
  const draft = new LearningInstructionsDraft({ save: async (patch) => { calls.push(patch); return settings("Use travel examples."); } });
  draft.load(settings());
  draft.edit(text);
  assert.equal(await draft.save(), true);
  assert.deepEqual(calls, [{ english_learning_instructions: "Use travel examples." }]);
});

test("custom guidance UI messages are present in all six interface languages", () => {
  const keys = Object.keys(messages.en).filter((key) => key.startsWith("learningInstructions"));
  assert.equal(keys.length, 11);
  for (const locale of ["en", "zh", "ja", "ko", "fr", "es"])
    for (const key of keys) assert.equal(typeof messages[locale][key], "string", `${locale}.${key}`);
});
