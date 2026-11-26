import assert from "node:assert/strict";
import test from "node:test";
import { EntryEditor } from "../web/entry-editor.js";

const base = { id: 7, revision: "r1", status: "new", note: "Confirmed note", scenes: ["Work"] };
const record = (status, revision, extra = {}) => ({ record: { ...base, status, revision, ...extra } });
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
const tick = async () => { for (let index = 0; index < 5; index++) await Promise.resolve(); };
function fixture(api, isCurrent = () => true) {
  const emitted = [], reflected = [];
  const editor = Object.create(EntryEditor.prototype);
  Object.assign(editor, { record: { ...base }, pending: {}, running: null, error: null, statusIntent: null,
    statusSequence: 0, statusRolledBack: false, statusUncertain: false, generation: 0, disposed: false,
    api, isCurrent, onChange: (value) => emitted.push({ ...value }), reflect: (key) => reflected.push(key) });
  return { editor, emitted, reflected };
}

test("the first status click updates the visible record immediately while confirmed state waits for the server", async () => {
  const pending = deferred(), calls = [];
  const { editor, emitted } = fixture(async (action, args) => { calls.push({ action, args }); return pending.promise; });
  const saving = editor.setStatus("mastered");
  assert.equal(emitted.at(-1).status, "mastered");
  assert.equal(editor.visibleRecord.status, "mastered");
  assert.equal(editor.record.status, "new");
  await tick();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].args.expected_revision, "r1");
  pending.resolve(record("mastered", "r2"));
  assert.equal(await saving, true);
  assert.equal(editor.record.status, "mastered");
  assert.equal(editor.statusIntent, null);
});

test("rapid toggles keep the last visible choice across old acknowledgments and share one revision sequence", async () => {
  const first = deferred(), second = deferred(), calls = [];
  const { editor, emitted } = fixture((action, args) => { calls.push(args); return calls.length === 1 ? first.promise : second.promise; });
  const firstSave = editor.setStatus("mastered");
  await tick();
  const finalSave = editor.setStatus("new");
  assert.equal(editor.visibleRecord.status, "new");
  first.resolve(record("mastered", "r2"));
  await tick();
  assert.equal(editor.record.status, "mastered");
  assert.equal(editor.visibleRecord.status, "new");
  assert.equal(emitted.at(-1).status, "new", "the old response never flashes the old choice");
  assert.deepEqual(calls.map((call) => [call.patch.status, call.expected_revision]), [["mastered", "r1"], ["new", "r2"]]);
  second.resolve(record("new", "r3"));
  assert.equal(await firstSave, true);
  assert.equal(await finalSave, true);
  assert.equal(editor.record.status, "new");
});

test("M-N-M coalesces the redundant status but preserves notes queued during the first write", async () => {
  const first = deferred(), calls = [];
  const { editor } = fixture((action, args) => {
    calls.push(args);
    return calls.length === 1 ? first.promise : Promise.resolve(record("mastered", "r3", { note: args.patch.note }));
  });
  const saving = editor.setStatus("mastered");
  await tick();
  editor.queue({ note: "Latest local note", scenes: ["Home"] });
  editor.setStatus("new");
  editor.setStatus("mastered");
  first.resolve(record("mastered", "r2"));
  assert.equal(await saving, true);
  assert.deepEqual(calls[1], { record_id: 7, patch: { note: "Latest local note", scenes: ["Home"] }, expected_revision: "r2" });
  assert.equal(calls.length, 2);
  assert.equal(editor.record.note, "Latest local note");
  assert.equal(editor.dirty, false);
});

test("a failed write rolls visible status back while retaining the latest status and note drafts", async () => {
  const pending = deferred();
  const { editor, emitted } = fixture(() => pending.promise);
  const saving = editor.setStatus("mastered");
  await tick();
  editor.queue({ note: "Do not lose this draft" });
  editor.setStatus("new");
  pending.reject(new Error("disconnected"));
  assert.equal(await saving, false);
  assert.equal(editor.record.status, "new");
  assert.equal(emitted.at(-1).status, "new");
  assert.deepEqual(editor.pending, { status: "new", note: "Do not lose this draft" });
  assert.equal(editor.error, "disconnected");
  assert.equal(editor.statusRolledBack, true);
  editor.dispose();
});

test("reversing an uncertain write to the old confirmed value still verifies and applies that intent", async () => {
  const first = deferred(), calls = [];
  let updates = 0;
  const { editor } = fixture((action, args) => {
    calls.push({ action, args });
    if (action === "points/read") return Promise.resolve(record("mastered", "r2"));
    ++updates;
    if (updates === 1) return first.promise;
    if (updates === 2) return Promise.reject(new Error("editConflict"));
    return Promise.resolve(record("new", "r3"));
  });
  const failed = editor.setStatus("mastered");
  await tick();
  first.reject(new Error("disconnected")); // The first request might already have committed.
  assert.equal(await failed, false);
  assert.equal(await editor.setStatus("new"), true);
  assert.deepEqual(calls.map((call) => call.action), ["points/update", "points/update", "points/read", "points/update"]);
  assert.equal(calls.at(-1).args.patch.status, "new");
  assert.equal(calls.at(-1).args.expected_revision, "r2");
  assert.equal(editor.record.status, "new");
});

test("status-only conflicts rebase once and retain server notes rather than resubmitting old content", async () => {
  const calls = [];
  const { editor } = fixture(async (action, args) => {
    calls.push({ action, args });
    if (action === "points/read") return record("new", "r2", { note: "New remote note", scenes: ["Home"] });
    if (calls.length === 1) throw new Error("editConflict");
    return record("mastered", "r3", { note: "New remote note", scenes: ["Home"] });
  });
  editor.noteInput = { value: "Confirmed note" };
  editor.sceneInput = { value: "Work" };
  editor.queueNoteResize = () => {};
  assert.equal(await editor.setStatus("mastered"), true);
  assert.deepEqual(calls.at(-1).args, { record_id: 7, patch: { status: "mastered" }, expected_revision: "r2" });
  assert.equal(editor.record.note, "New remote note");
  assert.equal(editor.noteInput.value, "New remote note", "subsequent typing starts from the remote note, not its stale predecessor");
  assert.equal(editor.sceneInput.value, "Home");
  let reads = 0, updates = 0;
  const bounded = fixture(async (action) => {
    if (action === "points/read") { ++reads; return record("new", "r2"); }
    ++updates; throw new Error("editConflict");
  });
  assert.equal(await bounded.editor.setStatus("mastered"), false);
  assert.equal(reads, 1);
  assert.equal(updates, 2);
});

test("a conflicting note/status batch is kept without automatic whole-note replay", async () => {
  const calls = [];
  const { editor } = fixture(async (action, args) => { calls.push({ action, args }); throw new Error("editConflict"); });
  editor.pending = { note: "Local note draft", scenes: ["Home"] };
  assert.equal(await editor.setStatus("mastered"), false);
  assert.equal(calls.length, 1);
  assert.deepEqual(editor.pending, { note: "Local note draft", scenes: ["Home"], status: "mastered" });
  assert.equal(editor.visibleRecord.status, "new");
});

test("notes typed while a status rebase is reading stop its retry without losing the draft", async () => {
  const read = deferred(), calls = [];
  const { editor } = fixture(async (action, args) => {
    calls.push({ action, args });
    if (action === "points/read") return read.promise;
    throw new Error("editConflict");
  });
  const saving = editor.setStatus("mastered");
  await tick();
  editor.noteInput = { value: "New local draft" };
  editor.queueNoteResize = () => { throw new Error("must not rewrite a local draft"); };
  editor.queue({ note: "New local draft" });
  read.resolve(record("new", "r2", { note: "Remote note" }));
  assert.equal(await saving, false);
  assert.equal(calls.length, 2);
  assert.equal(editor.pending.note, "New local draft");
  assert.equal(editor.noteInput.value, "New local draft");
  assert.equal(editor.pending.status, "mastered");
  editor.dispose();
});

test("permanent disposal and stale account guards suppress late replies and queued writes", async () => {
  for (const mode of ["dispose", "account"]) {
    const pending = deferred(), calls = [];
    let current = true;
    const { editor, emitted } = fixture((action, args) => { calls.push(args); return pending.promise; }, () => current);
    const saving = editor.setStatus("mastered");
    await tick();
    editor.setStatus("new");
    const before = emitted.length;
    if (mode === "dispose") editor.dispose(); else current = false;
    pending.resolve(record("mastered", "r2"));
    assert.equal(await saving, false);
    assert.equal(calls.length, 1);
    assert.equal(emitted.length, before);
    assert.equal(editor.record.revision, "r1");
    assert.equal(await editor.flush(), false);
    if (mode !== "dispose") editor.dispose();
  }
});

test("leave-page protection distinguishes text drafts from an ordinary background status write", async () => {
  const pending = deferred();
  const { editor } = fixture(() => pending.promise);
  const saving = editor.setStatus("mastered");
  await tick();
  assert.equal(editor.dirty, true);
  assert.equal(editor.hasUnsavedText, false);
  editor.queue({ note: "Still editing" });
  assert.equal(editor.hasUnsavedText, true);
  pending.reject(new Error("disconnected"));
  assert.equal(await saving, false);
  assert.equal(editor.hasUnsavedText, true);
  editor.dispose();
  const text = deferred();
  const next = fixture(() => text.promise);
  next.editor.pending = { scenes: ["Home"] };
  const writing = next.editor.flush();
  await tick();
  assert.equal(next.editor.hasUnsavedText, true, "in-flight text remains protected after pending is drained");
  next.editor.dispose();
  text.resolve(record("new", "r2"));
  assert.equal(await writing, false);
  assert.deepEqual(next.editor.pending.scenes, ["Home"], "an old-account draft remains copyable");
});

test("reloading saved content clears optimistic intent and ignores an older status reply", async () => {
  const update = deferred(), emitted = [];
  const { editor } = fixture((action) => action === "points/read" ? Promise.resolve(record("new", "r2")) : update.promise);
  editor.onChange = (value) => emitted.push(value);
  editor.node = { replaceWith() {} };
  editor.render = () => ({ replaceWith() {} });
  const saving = editor.setStatus("mastered");
  await tick();
  await editor.reloadSaved();
  assert.equal(editor.statusIntent, null);
  assert.equal(editor.visibleRecord.status, "new");
  const before = emitted.length;
  update.resolve(record("mastered", "r3"));
  assert.equal(await saving, false);
  assert.equal(editor.record.revision, "r2");
  assert.equal(emitted.length, before);
});

test("a status-only conflict can be resolved by a new explicit choice without weakening note conflicts", async () => {
  const { editor } = fixture(async (action) => {
    if (action === "points/read") return record("new", "r2");
    throw new Error("editConflict");
  });
  assert.equal(await editor.setStatus("mastered"), false);
  assert.equal(editor.error, "editConflict");
  assert.equal(await editor.setStatus("new"), true, "choosing the last confirmed value cancels the failed status intent");
  assert.equal(editor.error, null);
  editor.api = async (action, args) => {
    if (action === "points/read") return record("new", "r3");
    if (args.expected_revision === "r2") throw new Error("editConflict");
    return record("mastered", "r4");
  };
  assert.equal(await editor.setStatus("mastered"), true);
  assert.equal(editor.record.revision, "r4");
});
