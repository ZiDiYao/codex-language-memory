import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const source = await readFile(new URL("../web/export-model.js", import.meta.url), "utf8");
const { exportRange } = await import("data:text/javascript;base64," + Buffer.from(source).toString("base64"));

test("custom calendar dates cover the whole end day, including DST changes", () => {
  const previous = process.env.TZ;
  process.env.TZ = "America/Toronto";
  try {
    assert.deepEqual(exportRange("custom", "2026-11-01", "2026-11-01"), {
      start_at: "2026-11-01T04:00:00.000Z", end_at: "2026-11-02T05:00:00.000Z",
    });
    assert.deepEqual(exportRange("custom", "2026-03-08", "2026-03-08"), {
      start_at: "2026-03-08T05:00:00.000Z", end_at: "2026-03-09T04:00:00.000Z",
    });
    assert.deepEqual(exportRange("7", "", "", new Date("2026-11-08T17:00:00Z")), {
      start_at:"2026-11-02T05:00:00.000Z", end_at:"2026-11-09T05:00:00.000Z",
    });
  } finally { if (previous === undefined) delete process.env.TZ; else process.env.TZ = previous; }
});

test("empty, invalid and reversed custom dates fail instead of silently exporting everything", () => {
  for (const [from, through] of [["", ""], ["2026-02-30", ""], ["bad", ""], ["2026-11-09", "2026-11-08"]])
    assert.throws(() => exportRange("custom", from, through), /exportDateInvalid/);
  assert.deepEqual(exportRange("all"), {});
  assert.deepEqual(Object.keys(exportRange("custom", "2026-11-08", "")), ["start_at"]);
  assert.deepEqual(Object.keys(exportRange("custom", "", "2026-11-08")), ["end_at"]);
});
