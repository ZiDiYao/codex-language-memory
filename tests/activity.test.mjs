import test from "node:test";
import assert from "node:assert/strict";
import { ActivityController, isStudyClick, activityEventId } from "../web/activity.js";

const instant = Date.parse("2026-11-24T20:00:00.000Z");
const tick = () => new Promise((resolve) => setImmediate(resolve));
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function heatmap(timezone = "America/Toronto") {
  return { timezone, start_date: "2026-05-27", end_date: "2026-11-24", weights: { learning: 0.7, interaction: 0.3 },
    targets: { learning: 5, interaction: 10 }, days: Array.from({ length: 182 }, (_, offset) => ({
      date: new Date(Date.parse("2026-05-27T00:00:00Z") + offset * 86400000).toISOString().slice(0, 10),
      learning_count: 0, interaction_count: 0, score: 0, level: 0,
    })) };
}
function annualActivity(year, timezone = "America/Toronto", today = "2026-11-24") {
  const start = Date.UTC(year, 0, 1), end = Date.UTC(year, 11, 31);
  return { timezone, year, today, available_years: [Number(today.slice(0, 4)), 2024],
    start_date: `${year}-01-01`, end_date: `${year}-12-31`,
    days: Array.from({ length: (end - start) / 86400000 + 1 }, (_, offset) => ({
      date: new Date(start + offset * 86400000).toISOString().slice(0, 10), learning_count: 0, interaction_count: 0, score: 0, level: 0,
    })) };
}
function fixture(options = {}) {
  const requests = [], data = [], errors = [], loading = [], timers = new Map();
  let time = instant, counter = 0, timerId = 0, clears = 0;
  const controller = new ActivityController({
    request: async (action, args) => { requests.push({ action, args }); return action === "activity/read" ? heatmap(args.timezone) : { status: "accepted" }; },
    timezone: () => "America/Toronto", now: () => time,
    uuid: () => `00000000-0000-4000-8000-${String(++counter).padStart(12, "0")}`,
    onData: (value) => data.push(value), onError: (error) => errors.push(error.message),
    onLoading: (value) => loading.push(value), onClear: () => { ++clears; },
    schedule: (callback, delay) => { const id = ++timerId; timers.set(id, { callback, delay }); return id; },
    cancel: (id) => timers.delete(id), ...options,
  });
  return { controller, requests, data, errors, loading, timers, clears: () => clears,
    advance: (elapsed) => { time += elapsed; },
    async fire() { const [id, timer] = timers.entries().next().value; timers.delete(id); timer.callback(); await tick(); },
  };
}

test("activity event UUIDs use secure random bytes when randomUUID is unavailable in a host frame", () => {
  const id = activityEventId({ getRandomValues: (bytes) => bytes.fill(255) });
  assert.equal(id, "ffffffff-ffff-4fff-bfff-ffffffffffff");
});

test("interactions batch after ten seconds, contain only allowed fields and never trigger per-click requests", async () => {
  const f = fixture();
  assert.deepEqual(f.requests, []);
  for (let index = 0; index < 21; ++index) assert.equal(f.controller.record(index === 0 ? "pronunciation" : "button"), true);
  assert.equal(f.controller.record("auth"), false);
  assert.equal(f.timers.size, 1);
  assert.equal([...f.timers.values()][0].delay, 10000);
  assert.deepEqual(f.requests, []);
  await f.fire();
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].action, "activity/events");
  assert.equal(f.requests[0].args.events.length, 20);
  assert.deepEqual(f.requests[0].args.events[0], {
    event_id: "00000000-0000-4000-8000-000000000001", kind: "pronunciation", occurred_at: "2026-11-24T20:00:00.000Z",
  });
  for (const event of f.requests[0].args.events) assert.deepEqual(Object.keys(event).sort(), ["event_id", "kind", "occurred_at"]);
  assert.equal(f.timers.size, 1);
  await f.fire();
  assert.equal(f.requests[1].args.events.length, 1);
  assert.equal(f.timers.size, 0);
  assert.equal(new Set(f.requests.flatMap((request) => request.args.events.map((event) => event.event_id))).size, 21);
});

test("opening immediately after a click or pronunciation submits the queued batch before reading", async () => {
  const actions = [];
  let interactions = 0;
  const f = fixture({ request: async (action, args) => {
    actions.push(action);
    if (action === "activity/events") { interactions += args.events.length; return { status: "accepted" }; }
    const data = heatmap();
    data.days.at(-1).interaction_count = interactions;
    return data;
  } });
  f.controller.record("button");
  f.controller.record("pronunciation");
  assert.deepEqual(actions, []);
  assert.equal(await f.controller.open(), true);
  assert.deepEqual(actions, ["activity/events", "activity/read"]);
  assert.equal(f.data[0].days.at(-1).interaction_count, 2, "displayed counts come from the server after delivery");
  assert.equal(f.controller.queue.length, 0);
  assert.equal(f.timers.size, 0);
});

test("opening during a background write waits for it and one newly queued batch before GET", async () => {
  const first = deferred(), second = deferred();
  const actions = [];
  let writes = 0;
  const f = fixture({ request: (action) => {
    actions.push(action);
    return action === "activity/events" ? (++writes === 1 ? first.promise : second.promise) : Promise.resolve(heatmap());
  } });
  f.controller.record("button");
  const sending = f.controller.flush();
  f.controller.record("pronunciation");
  const reading = f.controller.open();
  await tick();
  assert.deepEqual(actions, ["activity/events"]);
  first.resolve({ status: "accepted" });
  await tick();
  assert.deepEqual(actions, ["activity/events", "activity/events"]);
  second.resolve({ status: "accepted" });
  await Promise.all([sending, reading]);
  assert.deepEqual(actions, ["activity/events", "activity/events", "activity/read"]);
  assert.equal(f.controller.queue.length, 0);
  assert.equal(f.timers.size, 0);
});

test("account invalidation while waiting for delivery cannot flush old queued events or read/render", async () => {
  const pending = deferred();
  const actions = [];
  const f = fixture({ request: (action) => { actions.push(action); return pending.promise; } });
  f.controller.record("button");
  const sending = f.controller.flush();
  f.controller.record("pronunciation");
  const reading = f.controller.open();
  await tick();
  f.controller.invalidate();
  assert.equal(await reading, false, "invalidation releases the read without waiting for a stalled write");
  pending.resolve({ status: "accepted" });
  await sending;
  assert.deepEqual(actions, ["activity/events"]);
  assert.deepEqual(f.data, []);
  assert.deepEqual(f.errors, []);
  assert.equal(f.controller.queue.length, 0);
  assert.equal(f.timers.size, 0);
});

test("a stalled explicit delivery wait is bounded and retains the last real heatmap without retries", async () => {
  const pending = deferred();
  const actions = [];
  const f = fixture({ writeWaitMs: 5, request: (action) => {
    actions.push(action);
    return action === "activity/events" ? pending.promise : Promise.resolve(heatmap());
  } });
  await f.controller.open();
  const previous = f.controller.cache;
  f.controller.close();
  f.controller.record("button");
  assert.equal(await f.controller.open(), false);
  assert.equal(f.controller.cache, previous);
  assert.deepEqual(actions, ["activity/read", "activity/events"]);
  assert.deepEqual(f.errors, ["activityUnavailable"]);
  pending.resolve({ status: "accepted" });
  await tick();
  assert.deepEqual(actions, ["activity/read", "activity/events"]);
  assert.equal(f.data.length, 1);
  assert.equal(f.controller.cache, previous);
  assert.equal(f.timers.size, 0);
});

test("failed event delivery is silent and never replayed or scheduled under another account", async () => {
  let calls = 0;
  const f = fixture({ request: async () => { ++calls; throw new Error("private token error"); } });
  f.controller.record("button");
  await f.fire();
  assert.equal(calls, 1);
  assert.deepEqual(f.errors, []);
  assert.equal(f.controller.queue.length, 0);
  assert.equal(f.timers.size, 0);
  f.controller.invalidate();
  assert.equal(await f.controller.flush(), false);
  assert.equal(calls, 1);
});

test("queue limits and event expiry keep background work bounded", async () => {
  const f = fixture();
  for (let index = 0; index < 100; ++index) assert.equal(f.controller.record("button"), true);
  assert.equal(f.controller.record("button"), false);
  f.advance(4 * 60 * 1000 + 1);
  await f.fire();
  assert.deepEqual(f.requests, []);
  assert.equal(f.controller.queue.length, 0);
  assert.equal(f.timers.size, 0);
});

test("account or page invalidation drops queued work and ignores late event completion", async () => {
  const old = deferred();
  const f = fixture({ request: () => old.promise });
  f.controller.record("button");
  const sending = f.controller.flush();
  f.controller.record("pronunciation");
  f.controller.invalidate();
  assert.equal(f.controller.queue.length, 0);
  assert.equal(f.timers.size, 0);
  old.resolve({ status: "accepted" });
  assert.equal(await sending, false);
  assert.equal(f.timers.size, 0);
  assert.equal(f.controller.cache, null);
  assert.equal(f.clears(), 1);
});

test("activity reads are lazy, single-flight on open and cached relabel never fetches", async () => {
  const f = fixture({ cacheLifetime: 60000 });
  const first = f.controller.open();
  assert.equal(f.controller.open(), first);
  await first;
  assert.deepEqual(f.requests, [{ action: "activity/read", args: { timezone: "America/Toronto", year: 2026 } }]);
  f.controller.relabel();
  assert.equal(f.data.length, 2);
  assert.equal(f.requests.length, 1);
  f.controller.close();
  await f.controller.open();
  assert.equal(f.requests.length, 1);
  await f.controller.refresh();
  assert.equal(f.requests.length, 2, "explicit refresh reads again without creating interaction events");
  assert.equal(f.timers.size, 0);
  assert.deepEqual(f.loading, [true, false, false, true, false]);
});

test("default profile reopens fetch fresh activity while retaining the last view during loading", async () => {
  const f = fixture();
  await f.controller.open();
  assert.equal(f.requests.length, 1);
  const previous = f.controller.cache;
  f.controller.close();
  const reopening = f.controller.open();
  assert.equal(f.controller.cache, previous);
  assert.equal(f.clears(), 0);
  assert.equal(f.controller.open(), reopening, "an in-flight reopen is shared");
  await reopening;
  assert.equal(f.requests.length, 2);
  assert.equal(f.timers.size, 0);
  f.controller.relabel();
  assert.equal(f.requests.length, 2);
});

test("closing a profile suppresses late rendering while preserving a same-account cache", async () => {
  const pending = deferred();
  const f = fixture({ request: () => pending.promise });
  const reading = f.controller.open();
  await tick();
  f.controller.close();
  pending.resolve(heatmap());
  await reading;
  assert.equal(f.data.length, 0);
  assert.ok(f.controller.cache);
  await f.controller.open();
  assert.equal(f.data.length, 1);
});

test("account invalidation suppresses stale activity data and errors before and after request start", async () => {
  const pending = deferred();
  const f = fixture({ request: () => pending.promise });
  const reading = f.controller.open();
  await tick();
  f.controller.invalidate();
  pending.resolve(heatmap());
  await reading;
  assert.equal(f.controller.cache, null);
  assert.deepEqual(f.data, []);
  assert.deepEqual(f.errors, []);
  const neverSent = fixture();
  const opening = neverSent.controller.open();
  neverSent.controller.invalidate();
  await opening;
  assert.deepEqual(neverSent.requests, []);
});

test("an older refresh cannot overwrite the newer heatmap or show a stale failure", async () => {
  const first = deferred(), second = deferred();
  let calls = 0;
  const f = fixture({ request: () => ++calls === 1 ? first.promise : second.promise });
  const old = f.controller.open();
  await tick();
  const latest = f.controller.refresh();
  second.resolve({ ...heatmap(), totals: { learning_count: 5 } });
  await latest;
  first.reject(new Error("private previous account detail"));
  await old;
  assert.equal(f.data.length, 1);
  assert.deepEqual(f.data[0].totals, { learning_count: 5 });
  assert.deepEqual(f.errors, []);
});

test("a malformed or failed activity read is localized and retryable without interaction writes", async () => {
  let calls = 0;
  const f = fixture({ request: () => {
    if (++calls === 1) throw new Error("private transport data");
    return Promise.resolve(heatmap());
  } });
  await f.controller.open();
  assert.deepEqual(f.errors, ["activityUnavailable"]);
  assert.equal(f.controller.pendingRead, null);
  await f.controller.refresh();
  assert.equal(f.data.length, 1);
  assert.equal(f.timers.size, 0);
});

test("incomplete activity results never become a cached successful heatmap", async () => {
  const f = fixture({ request: async () => ({ timezone: "America/Toronto", days: [] }) });
  assert.equal(await f.controller.open(), false);
  assert.equal(f.controller.cache, null);
  assert.deepEqual(f.errors, ["activityUnavailable"]);
  assert.deepEqual(f.data, []);
});

test("blocked accounts do not read or collect events", async () => {
  const f = fixture({ canUse: () => false });
  assert.equal(f.controller.record("button"), false);
  assert.equal(await f.controller.open(), false);
  assert.equal(await f.controller.refresh(), false);
  assert.equal(await f.controller.flush(), false);
  assert.deepEqual(f.requests, []);
});

test("only genuine marked study controls count; speaker, profile/auth, disabled, inert and programmatic clicks do not", () => {
  function event({ marked = true, speaker = false, disabled = false, inert = false, trusted = true, control = true } = {}) {
    const button = { disabled, closest(selector) {
      return selector === "[inert]" ? inert && {} : selector === "[data-study-activity]" ? marked && {} : null;
    } };
    return { isTrusted: trusted, target: { closest(selector) {
      return selector === "[data-activity-ignore], .entry-listen" ? speaker && {} : control ? button : null;
    } } };
  }
  assert.equal(isStudyClick(event()), true);
  for (const options of [{ marked: false }, { speaker: true }, { disabled: true }, { inert: true }, { trusted: false }, { control: false }])
    assert.equal(isStudyClick(event(options)), false);
  assert.equal(isStudyClick({ isTrusted: true, target: {} }), false);
});

test("year selection reads full leap years, clears stale day data and rejects an older response", async () => {
  const old = deferred(), latest = deferred();
  const requests = [], cleared = [];
  const f = fixture({ onClear: (options) => cleared.push(options), request: (action, args) => {
    requests.push(args.year);
    return args.year === 2025 ? old.promise : args.year === 2024 ? latest.promise : Promise.resolve(annualActivity(2026));
  } });
  await f.controller.open();
  const first = f.controller.selectYear(2025);
  assert.equal(f.controller.cache, null);
  await tick();
  const second = f.controller.selectYear(2024);
  latest.resolve(annualActivity(2024));
  await second;
  old.resolve(annualActivity(2025));
  await first;
  assert.deepEqual(requests, [2026, 2025, 2024]);
  assert.equal(f.controller.cache.year, 2024);
  assert.equal(f.controller.cache.days.length, 366);
  assert.deepEqual(cleared, [{ preserveYears: true, year: 2025 }, { preserveYears: true, year: 2024 }]);
  assert.deepEqual(f.data.map((data) => data.year), [2026, 2024]);
});

test("account invalidation resets selected year and suppresses late previous-account history", async () => {
  const pending = deferred();
  const requests = [];
  const f = fixture({ request: (action, args) => { requests.push(args.year);
    return args.year === 2024 ? pending.promise : Promise.resolve(annualActivity(2026));
  } });
  await f.controller.open();
  const old = f.controller.selectYear(2024);
  await tick();
  f.controller.invalidate();
  assert.equal(f.controller.selectedYear, null);
  await f.controller.open();
  pending.resolve(annualActivity(2024));
  await old;
  assert.deepEqual(requests, [2026, 2024, 2026]);
  assert.equal(f.controller.cache.year, 2026);
  assert.deepEqual(f.data.map((data) => data.year), [2026, 2026]);
});

test("legacy182 responses remain partial current-year data and never impersonate a selected historical year", async () => {
  const f = fixture();
  assert.equal(await f.controller.open(), true);
  assert.equal(f.controller.cache.year, undefined);
  assert.equal(await f.controller.selectYear(2024), false);
  assert.equal(f.controller.cache, null);
  assert.equal(f.data.length, 1);
  assert.deepEqual(f.errors, ["activityYearUnavailable"]);
});

test("a timezone change cannot retain a selection that became a future year", async () => {
  let timezone = "Pacific/Auckland";
  const years = [];
  const f = fixture({ now: () => Date.parse("2026-12-31T12:00:00Z"), timezone: () => timezone,
    request: async (_action, args) => { years.push(args.year);
      return annualActivity(args.year, timezone, timezone === "Pacific/Auckland" ? "2027-01-01" : "2026-12-31");
    } });
  await f.controller.open(); f.controller.close();
  timezone = "America/Toronto";
  await f.controller.open();
  assert.deepEqual(years, [2027, 2026]);
  assert.equal(f.controller.selectedYear, 2026);
});

test("reopening in a new timezone replaces an in-flight year scope and discards the old result", async () => {
  let timezone = "Pacific/Auckland";
  const pending = deferred(), requests = [];
  const f = fixture({ now: () => Date.parse("2026-12-31T12:00:00Z"), timezone: () => timezone,
    request: (_action, args) => {
      requests.push(args);
      return args.timezone === "Pacific/Auckland" ? pending.promise :
        Promise.resolve(annualActivity(args.year, args.timezone, "2026-12-31"));
    } });
  const old = f.controller.open();
  await tick();
  f.controller.close();
  timezone = "America/Toronto";
  const current = f.controller.open();
  assert.notEqual(current, old);
  assert.equal(f.controller.open(), current, "the new matching scope still shares its in-flight request");
  await current;
  pending.resolve(annualActivity(2027, "Pacific/Auckland", "2027-01-01"));
  await old;
  assert.deepEqual(requests, [{ timezone: "Pacific/Auckland", year: 2027 }, { timezone: "America/Toronto", year: 2026 }]);
  assert.deepEqual(f.data.map((data) => [data.timezone, data.year]), [["America/Toronto", 2026]]);
  assert.equal(f.controller.selectedYear, 2026);
  assert.equal(f.controller.cache.year, 2026);
});
