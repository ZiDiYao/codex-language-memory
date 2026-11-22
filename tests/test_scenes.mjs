import assert from "node:assert/strict";
import { test } from "node:test";
import { parseScenes, sceneSelection, sceneLabel } from "../web/scene-model.js";
import { EntryEditor } from "../web/entry-editor.js";
import { RecordFeed } from "../web/record-feed.js";

test("scene editing accepts overlapping natural names and Chinese separators without duplicates", () => {
  assert.deepEqual(parseScenes(" Cleaning & hygiene，Daily routines；cleaning & hygiene; Ｄａｉｌｙ routines "),
    ["Cleaning & hygiene", "Daily routines"]);
  assert.deepEqual(parseScenes("  ,，;；  "), []);
  assert.throws(() => parseScenes(Array.from({ length: 13 }, (_, i) => `Scene ${i}`).join(",")), /invalidScenes/);
  assert.throws(() => parseScenes("a".repeat(81)), /invalidScenes/);
  assert.deepEqual(parseScenes("𠮷".repeat(80)), ["𠮷".repeat(80)]);
});

test("changing language or type clears a scene only when it no longer exists in that scope", () => {
  const scenes = [{ name: "Body reactions", count: 2 }, { name: "Daily routines", count: 1 }];
  assert.equal(sceneSelection(scenes, "Body reactions"), "Body reactions");
  assert.equal(sceneSelection(scenes, "Device controls"), "");
  assert.equal(sceneSelection([], "Body reactions"), "");
  assert.equal(sceneLabel("Body reactions", (key) => ({ sceneBody: "身体反应" })[key]), "身体反应");
  assert.equal(sceneLabel("At the dentist", () => { throw new Error("not a UI key"); }), "At the dentist");
});

test("scene and type filters combine on every page and reset the cursor when changed", async () => {
  const calls = [];
  const feed = new RecordFeed({
    fetchPage: async (args) => {
      calls.push(args);
      return { records: [{ id: calls.length }], has_more: calls.length === 1, next_cursor: calls.length === 1 ? "body-next" : null };
    },
    canCommit: () => true, onStart() {}, onCommit() {}, onError(error) { throw error; }, onFinish() {},
  });
  await feed.load({ reset: true, amount: 1, filters: { language: "en", scene: "Body reactions", kind: "word" } });
  await feed.load({ amount: 1, filters: { language: "en", scene: "Body reactions", kind: "word" } });
  await feed.load({ reset: true, amount: 1, filters: { language: "en", scene: "Device controls", kind: "expression" } });
  assert.deepEqual(calls, [
    { language: "en", scene: "Body reactions", kind: "word", limit: 1 },
    { language: "en", scene: "Body reactions", kind: "word", limit: 1, cursor: "body-next" },
    { language: "en", scene: "Device controls", kind: "expression", limit: 1 },
  ]);
});

function editorFixture(api) {
  const editor = Object.create(EntryEditor.prototype);
  Object.assign(editor, {
    record: { id: 7, revision: "first", scenes: ["Body reactions"] },
    pending: {}, running: null, error: null, api, onChange() {}, reflect() {},
  });
  return editor;
}

test("scene edits use revisions, preserve failed drafts and allow explicitly clearing every scene", async () => {
  const calls = [];
  let conflict = true;
  const editor = editorFixture(async (action, args) => {
    calls.push({ action, args });
    if (conflict) throw new Error("editConflict");
    return { record: { id: 7, revision: "second", scenes: [] } };
  });
  editor.pending = { scenes: [] };
  assert.equal(await editor.flush(), false);
  assert.deepEqual(editor.pending, { scenes: [] });
  assert.equal(editor.error, "editConflict");
  assert.equal(await editor.flush(), false);
  assert.equal(calls.length, 1);
  conflict = false;
  editor.error = null;
  assert.equal(await editor.flush(), true);
  assert.deepEqual(calls[1], { action: "points/update", args: { record_id: 7, patch: { scenes: [] }, expected_revision: "first" } });
  assert.equal(editor.record.revision, "second");
  assert.equal(editor.dirty, false);
});

test("invalid scene drafts and active composition block navigation saves", async () => {
  const editor = editorFixture(() => { throw new Error("must not write"); });
  editor.invalidSceneDraft = true;
  assert.equal(editor.dirty, true);
  assert.equal(await editor.flush(), false);
  editor.invalidSceneDraft = false;
  editor.sceneComposing = true;
  assert.equal(await editor.flush(), false);
});
