import assert from "node:assert/strict";
import test from "node:test";
import { webcrypto } from "node:crypto";
import { createBrowserHistoryStorage, HistoryPosition, historyFilterKey, validHistoryState } from "../web/history-position.js";

const filters = { include_variants: true, language: "en" };
const view = (latest = 10) => ({ anchor_id: 17, anchor_top: -24, scroll_y: 4200, loaded_count: 120, expanded_ids: [17, 18], latest_point_id: latest });
const state = (latest = 10, scope = filters) => ({ filter_key: JSON.stringify(scope), filters: { ...scope }, view: view(latest) });
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function fixture({ saved = state(), restore = async () => true, storage, ...options } = {}) {
  const writes = [], plans = [];
  let currentFilters = { ...filters };
  const position = new HistoryPosition({
    storage: storage ?? { read: async () => saved, write: async (next) => { writes.push(next); return next; } },
    getFilters: () => currentFilters,
    capture: () => { const { latest_point_id, ...captured } = view(); return captured; },
    restore: async (plan) => { plans.push(plan); position.committed(plan.filters); return restore(plan); },
    ...options,
  });
  return { position, writes, plans, select(next) { currentFilters = next; position.committed(next); } };
}

test("a reopen without a new point restores its deep page, anchor and expanded cards", async () => {
  const f = fixture();
  f.position.observe(10);
  assert.equal(await f.position.resume({ initial: true, contentVersion: 99 }), true);
  assert.equal(f.plans[0].toTop, false);
  assert.equal(f.plans[0].state.view.loaded_count, 120);
  assert.equal(f.plans[0].state.view.anchor_id, 17);
  assert.deepEqual(f.plans[0].state.view.expanded_ids, [17, 18]);
  f.position.observe(10); // An edit, merged encounter or enrichment changes content, not creation identity.
  assert.equal(await f.position.resume({ contentVersion: 100 }), true);
  assert.equal(f.plans.at(-1).toTop, false);
  assert.equal(f.position.acknowledgedPointId, 10);
});

test("background synchronization retains an unacknowledged creation even if total record count is unchanged", async () => {
  const f = fixture();
  f.position.observe(10);
  await f.position.resume({ initial: true });
  f.position.observe(11); // A new row replaces a deleted row: count is irrelevant.
  await f.position.save();
  assert.equal(f.writes.at(-1).view.latest_point_id, 10);
  assert.equal(f.plans.length, 1, "polling/scroll saves never move the reader");
  await f.position.resume();
  assert.equal(f.plans.at(-1).toTop, true);
  assert.equal(f.position.acknowledgedPointId, 11);
  await f.position.save();
  assert.equal(f.writes.at(-1).view.latest_point_id, 11);
});

test("failed or user-canceled top restoration does not acknowledge the new point", async () => {
  const pending = deferred();
  let succeed = true;
  const f = fixture({ restore: (plan) => plan.toTop ? pending.promise : Promise.resolve(succeed) });
  f.position.observe(10);
  await f.position.resume({ initial: true });
  f.position.observe(11);
  const restoring = f.position.resume();
  await Promise.resolve(); await Promise.resolve();
  f.position.cancelRestore();
  pending.resolve(true);
  assert.equal(await restoring, false);
  assert.equal(f.position.acknowledgedPointId, 10);
  await f.position.save();
  assert.equal(f.writes.at(-1).view.latest_point_id, 10);
  const failed = fixture({ restore: async () => false });
  failed.position.observe(11);
  assert.equal(await failed.position.resume({ initial: true }), false);
  assert.equal(failed.position.acknowledgedPointId, null);
});

test("late account reads cannot restore or save another account's checkpoint", async () => {
  const old = deferred(), writes = [], plans = [];
  const position = new HistoryPosition({ storage: { read: () => old.promise, write: async (value) => writes.push(value) },
    getFilters: () => filters, capture: () => view(), restore: async (plan) => { plans.push(plan); return true; } });
  position.observe(10);
  const reading = position.resume({ initial: true });
  await Promise.resolve();
  position.invalidate();
  position.observe(1);
  old.resolve(state());
  assert.equal(await reading, false);
  assert.deepEqual(plans, []);
  assert.deepEqual(writes, []);
  assert.equal(position.latestPointId, 1);
});

test("the acknowledged watermark never goes backwards when selecting an older filter checkpoint", async () => {
  const french = { include_variants: true, language: "fr" };
  const f = fixture({ storage: { read: async ({ filter_key } = {}) => filter_key === JSON.stringify(french) ? state(4, french) : state(10), write: async (next) => next } });
  f.position.observe(20);
  await f.position.resume({ initial: true });
  assert.equal(f.position.acknowledgedPointId, 20);
  f.select(french);
  await f.position.resume();
  assert.equal(f.plans.at(-1).toTop, false);
  assert.equal(f.position.acknowledgedPointId, 20);
  f.position.observe(19); // Deleting the largest current row is not a creation event.
  await f.position.resume();
  assert.equal(f.position.acknowledgedPointId, 20);
});

test("native responses may expand default filters without changing the saved scope", async () => {
  const expanded = { ...state(), filters: { keyword: null, kind: null, scene: null, status: null, language: "en", include_variants: true, needs_enrichment: false } };
  assert.equal(validHistoryState(expanded), true);
  const f = fixture({ saved: expanded });
  f.position.observe(10);
  await f.position.resume({ initial: true });
  assert.deepEqual(f.plans[0].filters, filters);
  assert.equal(validHistoryState({ ...expanded, filters: { ...expanded.filters, language: "fr" } }), false);
  assert.equal(historyFilterKey({ user_id: "another" }), null);
});

test("browser checkpoints persist metadata with hashed origin/issuer/account isolation", async () => {
  const values = new Map(), store = { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
  const options = { apiBaseUrl: "https://api.example/path", issuer: "https://issuer.example/", subject: "alice-private-id", storage: store, crypto: webcrypto };
  const first = createBrowserHistoryStorage(options);
  await first.write(state());
  assert.equal([...values.keys()][0].includes("alice"), false);
  assert.match([...values.keys()][0], /^sayrove\.history\.v1\.[a-f0-9]{64}$/);
  assert.deepEqual(await createBrowserHistoryStorage(options).read(), state());
  for (const changed of [{ subject: "bob" }, { issuer: "https://other.example/" }, { apiBaseUrl: "https://other-api.example" }])
    assert.equal((await createBrowserHistoryStorage({ ...options, ...changed }).read()).view, null);
  assert.equal([...values.values()][0].includes("alice-private-id"), false);
});

test("blocked browser storage, unavailable native storage and malformed snapshots do not block the library", async () => {
  const browser = createBrowserHistoryStorage({ apiBaseUrl: "https://api.example", issuer: "https://issuer.example", subject: "alice", crypto: webcrypto,
    storage: { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("quota"); } } });
  await browser.write(state());
  assert.deepEqual(await browser.read(), state(), "storage failures retain this page's memory snapshot");
  const f = fixture({ storage: { read: async () => { throw new Error("offline"); }, write: async () => { throw new Error("offline"); } } });
  f.position.observe(10);
  assert.equal(await f.position.resume({ initial: true }), true);
  assert.equal(f.plans[0].state, null);
  assert.equal(validHistoryState({ ...state(), view: { ...view(), scroll_y: Infinity } }), false);
  assert.equal(validHistoryState({ ...state(), view: { ...view(), loaded_count: 2001 } }), false);
});
