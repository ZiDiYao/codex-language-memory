import assert from "node:assert/strict";
import { test } from "node:test";
import { enrichmentSummary } from "../web/history-model.js";
import { messages } from "../web/i18n.js";

test("an accepted raw point has its target title while note preparation changes independently of mastery", () => {
  const point = Object.freeze({ title: "celery", note_title: "", note_is_custom: false, status: "new" });
  assert.deepEqual(enrichmentSummary({ ...point, enrichment_state: "pending" }), {
    title: "celery", messageKey: "enrichmentPending",
  });
  assert.equal(enrichmentSummary({ ...point, enrichment_state: "processing", status: "mastered" }).messageKey,
    "enrichmentPending");
  assert.equal(enrichmentSummary({ ...point, enrichment_state: "failed" }).messageKey, "enrichmentFailed");
  assert.deepEqual(enrichmentSummary({ ...point, enrichment_state: "ready", note_title: "celery", note_preview: "芹菜" }), {
    title: "celery", messageKey: null,
  });
  assert.equal(point.status, "new");
  assert.equal(point.note_title, "");
});

test("custom notes, including an explicitly empty note, keep their own title", () => {
  for (const enrichment_state of ["pending", "processing", "failed", "ready"]) {
    const edited = { title: "celery", note_title: "My food notes", note_is_custom: true, enrichment_state };
    assert.equal(enrichmentSummary(edited).title, "My food notes");
    assert.equal(enrichmentSummary({ ...edited, note_title: "" }).title, "");
  }
});

test("old servers and unknown preparation states do not invent a pending or failure message", () => {
  for (const enrichment_state of [undefined, null, "future-state", "ready"]) {
    assert.deepEqual(enrichmentSummary({ note_title: "My note", enrichment_state }), {
      title: "My note", messageKey: null,
    });
  }
});

test("preparation messages use the selected interface language", () => {
  assert.equal(messages.zh[enrichmentSummary({ enrichment_state: "pending" }).messageKey], "整理中");
  assert.equal(messages.zh[enrichmentSummary({ enrichment_state: "failed" }).messageKey], "整理暂未完成");
  for (const translations of Object.values(messages)) {
    assert.ok(translations.enrichmentPending.trim());
    assert.ok(translations.enrichmentFailed.trim());
  }
});
