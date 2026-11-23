import test from "node:test";
import assert from "node:assert/strict";
import { accountCanRead, accountStatus, authorizationUrl, createLocalProfile, LocalAccountSession } from "../web/local-profile.js";
import { request, setAccountEpoch } from "../web/transport.js";

const local = { mode: "local", state: "signed_out", epoch: 0, capabilities: { export: true, speech: true } };
const connected = { mode: "cloud", state: "connected", epoch: 2, capabilities: { export: false, speech: true } };
const signedOut = { ...connected, state: "signed_out", epoch: 3 };
const authUrl = "https://language-memory.ca.auth0.com/authorize?state=opaque-test-state&code_challenge=opaque-test-challenge";
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };
function setup(overrides = {}) {
  const events = [];
  const session = new LocalAccountSession({
    call: async () => local,
    beforeChange: async () => { events.push("flush"); return true; },
    onPause: (paused) => events.push(["pause", !!paused]),
    onSourceChange: async (status) => events.push(["source", status.mode, status.state, status.epoch]),
    onState: () => {}, onError: (key) => events.push(["error", key]),
    openExternal: async (url) => events.push(["browser", url]),
    schedule: () => 1, cancel: () => {}, ...overrides,
  });
  return { session, events };
}

test("default account polling timers preserve the browser global receiver when queued and disposed", () => {
  const previousSetTimeout = globalThis.setTimeout;
  const previousClearTimeout = globalThis.clearTimeout;
  const timer = { id: "account-poll" };
  const canceled = [];
  let scheduled = 0;
  try {
    globalThis.setTimeout = function (callback, delay) {
      assert.equal(this, globalThis, "Window.setTimeout requires the Window receiver");
      assert.equal(typeof callback, "function");
      assert.equal(delay, 5000);
      scheduled++;
      return timer;
    };
    globalThis.clearTimeout = function (value) {
      assert.equal(this, globalThis, "Window.clearTimeout requires the Window receiver");
      canceled.push(value);
    };
    const { session } = setup({ schedule: undefined, cancel: undefined });
    session.queue();
    assert.equal(scheduled, 1);
    assert.equal(session.timer, timer);
    session.dispose();
    assert.deepEqual(canceled, [undefined, timer]);
  } finally {
    globalThis.setTimeout = previousSetTimeout;
    globalThis.clearTimeout = previousClearTimeout;
  }
});

test("account switching waits for saved drafts, rejects duplicate clicks, and never switches after a failed flush", async () => {
  const flush = deferred();
  const calls = [];
  const { session, events } = setup({ beforeChange: () => flush.promise, call: async (action) => { calls.push(action); return connected; } });
  await session.accept(local);
  const first = session.change("account/connect");
  assert.equal(await session.change("account/use-local"), false);
  assert.deepEqual(calls, []);
  flush.resolve(false);
  assert.equal(await first, false);
  assert.deepEqual(calls, []);
  assert.equal(session.status.mode, "local");
  assert.ok(events.some((event) => event[0] === "error" && event[1] === "accountUnsaved"));
});

test("sign-in opens only the backend authorization page and signing out keeps the cloud source selected", async () => {
  const calls = [];
  const responses = [local, { ...connected, epoch: 1, state: "connecting", authorization_url: authUrl }, connected, signedOut, { ...local, epoch: 4 }];
  const { session, events } = setup({ call: async (action) => { calls.push(action); return responses.shift(); } });
  await session.refresh();
  await session.change("account/connect");
  assert.equal(accountCanRead(session.status), false);
  assert.equal(events.filter((event) => event[0] === "browser").length, 1);
  await session.refresh();
  assert.equal(accountCanRead(session.status), true);
  await session.change("account/disconnect");
  assert.equal(session.status.mode, "cloud");
  assert.equal(accountCanRead(session.status), false);
  assert.equal(session.status.capabilities.export, false);
  await session.change("account/use-local");
  assert.equal(session.status.mode, "local");
  assert.deepEqual(calls, ["account/status", "account/connect", "account/status", "account/disconnect", "account/use-local"]);
});

test("an old status response cannot restore records from the account that was just signed out", async () => {
  const old = deferred();
  const { session, events } = setup({ call: (action) => action === "account/status" ? old.promise : Promise.resolve(signedOut) });
  await session.accept(connected);
  const reading = session.refresh();
  await session.change("account/disconnect");
  old.resolve(connected);
  await reading;
  assert.equal(session.status.state, "signed_out");
  assert.equal(session.status.epoch, 3);
  assert.deepEqual(events.filter((event) => event[0] === "source").at(-1), ["source", "cloud", "signed_out", 3]);
});

test("authorization URLs reject other origins, unsafe schemes, credentials, fragments and unexpected provider endpoints", () => {
  assert.equal(authorizationUrl(authUrl), authUrl);
  for (const url of ["javascript:alert(1)", "http://language-memory.ca.auth0.com/authorize", "https://language-memory.ca.auth0.com.evil.example/authorize", "https://user:secret@language-memory.ca.auth0.com/authorize", "https://language-memory.ca.auth0.com/authorize#secret", "https://language-memory.ca.auth0.com/oauth/token"])
    assert.throws(() => authorizationUrl(url));
  const status = accountStatus({ ...local, can_connect: false, access_token: "never-expose", sub: "private-account-id" });
  assert.equal(status.can_connect, false);
  assert.equal(status.access_token, undefined);
  assert.equal(status.sub, undefined);
});

test("disposing a page suppresses a late account response and cancels status polling", async () => {
  const old = deferred();
  let canceled = 0;
  const { session, events } = setup({ call: () => old.promise, cancel: () => { canceled++; } });
  const reading = session.refresh();
  session.dispose();
  old.resolve(connected);
  await reading;
  assert.equal(session.status, null);
  assert.equal(events.filter((event) => event[0] === "source").length, 0);
  assert.ok(canceled > 0);
});

test("local data requests bind the observed account epoch while account actions and the web runtime keep their own contract", async () => {
  const previousHost = globalThis.languageMemoryHost;
  const previousRuntime = globalThis.languageMemoryRuntime;
  const calls = [];
  try {
    delete globalThis.languageMemoryRuntime;
    globalThis.languageMemoryHost = { request: async (route, payload) => { calls.push({ route, payload }); return Response.json({}); } };
    setAccountEpoch(7);
    await request("api", { action: "points/update", arguments: { record_id: 4, patch: { note: "draft" } } });
    await request("api", { action: "account/disconnect", arguments: {} });
    assert.equal(calls[0].payload.expected_epoch, 7);
    assert.equal(calls[1].payload.expected_epoch, undefined);
    globalThis.languageMemoryRuntime = { request: async (route, payload) => { calls.push({ route, payload }); return Response.json({}); } };
    await request("api", { action: "points/query", arguments: {} });
    assert.equal(calls[2].payload.expected_epoch, undefined);
  } finally {
    setAccountEpoch(null);
    if (previousHost) globalThis.languageMemoryHost = previousHost; else delete globalThis.languageMemoryHost;
    if (previousRuntime) globalThis.languageMemoryRuntime = previousRuntime; else delete globalThis.languageMemoryRuntime;
  }
});

test("the default ready local store offers Sign in while legacy stores that cannot connect hide it", async () => {
  const nodes = new Map();
  const node = (selector) => {
    if (!nodes.has(selector)) nodes.set(selector, { hidden: false, addEventListener() {}, querySelectorAll: () => [], setAttribute() {}, focus() {} });
    return nodes.get(selector);
  };
  const profile = createLocalProfile({ root: { querySelector: node }, t: (key) => key,
    openDialog() {}, closeDialog() {}, call: async () => local, beforeChange: async () => true,
    onPause() {}, onSourceChange: async () => {}, openExternal: async () => {}, schedule: () => 1, cancel() {} });
  await profile.session.accept({ ...local, state: "connected", can_connect: true });
  assert.equal(node("#local-profile-connect").hidden, false);
  assert.equal(node("#local-profile-disconnect").hidden, true);
  assert.equal(node("#local-profile-mode").textContent, "accountLocal");
  await profile.session.accept({ ...local, state: "connected", can_connect: false });
  assert.equal(node("#local-profile-connect").hidden, true);
});
