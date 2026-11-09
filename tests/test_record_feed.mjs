import assert from "node:assert/strict";
import { test } from "node:test";
import { RecordFeed } from "../web/record-feed.js";

const page = (ids, cursor = null) => ({
  records: ids.map((id) => ({ id })), has_more: cursor !== null, next_cursor: cursor,
});

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function fixture(fetchPage, options = {}) {
  const commits = [], errors = [], finished = [];
  const feed = new RecordFeed({
    fetchPage, canCommit: () => true, onStart: () => {},
    onCommit: (data, view) => commits.push({ data, view }),
    onError: (error) => errors.push(error.message),
    onFinish: () => finished.push(true), ...options,
  });
  return { feed, commits, errors, finished };
}

test("a late search response cannot overwrite a newer search or its loading state", async () => {
  const old = deferred(), current = deferred();
  const { feed, commits, finished } = fixture(({ keyword }) => keyword === "old" ? old.promise : current.promise);
  const first = feed.load({ reset: true, filters: { keyword: "old" } });
  const second = feed.load({ reset: true, filters: { keyword: "mi" } });
  old.resolve(page([1], "old-cursor"));
  assert.equal(await first, false);
  assert.equal(feed.loading, true);
  assert.equal(finished.length, 0);
  current.resolve(page([2]));
  assert.equal(await second, true);
  assert.deepEqual(commits.map(({ data }) => data.records), [[{ id: 2 }]]);
  assert.equal(feed.loading, false);
  assert.equal(finished.length, 1);
});

test("an old failed request cannot replace the latest successful result with an error", async () => {
  const old = deferred();
  const { feed, errors, commits } = fixture(({ keyword }) => keyword === "old" ? old.promise : page([2]));
  const first = feed.load({ reset: true, filters: { keyword: "old" } });
  await feed.load({ reset: true });
  old.reject(new Error("unavailable"));
  assert.equal(await first, false);
  assert.deepEqual(errors, []);
  assert.equal(feed.failed, false);
  assert.equal(commits.length, 1);
});

test("refresh restores multiple pages with one filter snapshot and no oversized request", async () => {
  const first = deferred(), calls = [];
  const { feed, commits } = fixture((args) => {
    calls.push(args);
    return calls.length === 1 ? first.promise : page([51, 52]);
  });
  const filters = { language: "en", keyword: "mi" };
  const view = { preserve: true, anchorId: "12" };
  const loading = feed.load({ reset: true, filters, amount: 52, view });
  filters.language = "fr";
  first.resolve(page(Array.from({ length: 50 }, (_, index) => index + 1), "next"));
  assert.equal(await loading, true);
  assert.deepEqual(calls, [
    { language: "en", keyword: "mi", limit: 50 },
    { language: "en", keyword: "mi", limit: 2, cursor: "next" },
  ]);
  assert.equal(commits[0].data.records.length, 52);
  assert.equal(commits[0].view, view);
});

test("infinite scroll ignores overlapping requests and stops at the last page", async () => {
  const first = deferred(), calls = [];
  const { feed } = fixture((args) => {
    calls.push(args);
    return calls.length === 1 ? first.promise : page([2]);
  });
  const loading = feed.load({ amount: 1 });
  assert.equal(await feed.load({ amount: 1 }), false);
  first.resolve(page([1], "next"));
  await loading;
  await feed.load({ amount: 1 });
  assert.equal(calls[1].cursor, "next");
  assert.equal(await feed.load(), false);
  assert.equal(calls.length, 2);
});

test("a failed page waits for an explicit retry and then recovers", async () => {
  let calls = 0;
  const { feed, errors, commits } = fixture(() => {
    if (++calls === 1) throw new Error("unavailable");
    return page([1]);
  });
  assert.equal(await feed.load(), false);
  assert.equal(feed.loading, false);
  assert.equal(await feed.load(), false);
  assert.equal(calls, 1);
  assert.equal(await feed.load({ reset: true }), true);
  assert.equal(feed.failed, false);
  assert.deepEqual(errors, ["unavailable"]);
  assert.equal(commits.length, 1);
});

test("an edit started during refresh prevents replacement of the editor", async () => {
  const pending = deferred();
  let dirty = false;
  const { feed, commits, errors } = fixture(() => pending.promise, { canCommit: () => !dirty });
  const loading = feed.load({ reset: true });
  dirty = true;
  pending.resolve(page([1]));
  assert.equal(await loading, false);
  assert.deepEqual(commits, []);
  assert.deepEqual(errors, []);
  assert.equal(feed.loading, false);
});

test("a superseded multi-page refresh stops fetching further pages", async () => {
  const pending = deferred(), calls = [];
  const { feed, commits } = fixture((args) => {
    calls.push(args);
    return args.language === "en" ? pending.promise : page([99]);
  });
  const old = feed.load({ reset: true, amount: 100, filters: { language: "en" } });
  await feed.load({ reset: true, filters: { language: "fr" } });
  pending.resolve(page(Array.from({ length: 50 }, (_, i) => i), "more"));
  assert.equal(await old, false);
  assert.equal(calls.length, 2);
  assert.deepEqual(commits[0].data.records, [{ id: 99 }]);
});
