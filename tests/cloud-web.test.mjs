import assert from "node:assert/strict";
import { test } from "node:test";
import { CloudAuthError, CloudSession, auth0Options, completeCloudCallback } from "../web/cloud-auth.js";
import { createCloudTransport, validateCloudConfig } from "../web/cloud-transport.js";
import { applyCloudMessages, detectCloudLocale } from "../web/cloud-i18n.js";
import { messages } from "../web/i18n.js";
import { capabilities, request } from "../web/transport.js";

const issuer = "https://language-memory.ca.auth0.com/";
// This token is only a UI identity fixture, not a cryptographic authentication fixture.
const uiToken = (subject) => "header." + Buffer.from(JSON.stringify({ iss: issuer, sub: subject })).toString("base64url") + ".signature";
function deferred() {
  let resolve;
  const promise = new Promise((yes) => { resolve = yes; });
  return { promise, resolve };
}
function sessionFixture(subject = "alice") {
  const notifications = [], logouts = [];
  const state = { subject, token: uiToken(subject), calls: 0 };
  const client = {
    async getTokenSilently() { ++state.calls; return state.token; },
    async getUser() { return { sub: state.subject }; },
    async logout(options) { logouts.push(options); },
  };
  const session = new CloudSession(client, { issuer, onRequired: (reason) => notifications.push(reason) });
  return { session, state, client, notifications, logouts };
}

test("cloud transport preserves compound filters/cursors and revision writes without ambient cookies or token URLs", async () => {
  const { session } = sessionFixture();
  const calls = [];
  const transport = createCloudTransport({ apiBaseUrl: "https://memory.example", session, fetchImpl: async (url, options) => {
    calls.push({ url, options });
    return Response.json({ status: "failed", error: "edit_conflict" }, { status: 409 });
  } });
  const response = await transport.request("api", { action: "points/query", arguments: {
    scene: "Body reactions & health", kind: "word", language: "en", cursor: "a/+==", include_variants: true, status: null,
  } });
  assert.equal(response.status, 409);
  const query = new URL(calls[0].url);
  assert.equal(query.pathname, "/v1/points");
  assert.equal(query.searchParams.get("scene"), "Body reactions & health");
  assert.equal(query.searchParams.get("cursor"), "a/+==");
  assert.equal(query.searchParams.get("kind"), "word");
  assert.equal(query.searchParams.has("status"), false);
  await transport.request("api", { action: "points/update", arguments: {
    record_id: 7, patch: { note: "My private draft", scenes: [] }, expected_revision: "a".repeat(64),
  } });
  assert.equal(new URL(calls[1].url).pathname, "/v1/points/7");
  assert.equal(calls[1].options.method, "PATCH");
  assert.deepEqual(JSON.parse(calls[1].options.body), { patch: { note: "My private draft", scenes: [] }, expected_revision: "a".repeat(64) });
  for (const { url, options } of calls) {
    assert.equal(options.credentials, "omit");
    assert.equal(options.redirect, "error");
    assert.equal(options.headers.Authorization, "Bearer " + uiToken("alice"));
    assert.equal(url.includes(uiToken("alice")), false);
  }
});

test("an API 401 pauses all requests and never retries an autosave under another credential", async () => {
  const { session, notifications, state } = sessionFixture();
  let fetches = 0;
  const transport = createCloudTransport({ apiBaseUrl: "https://memory.example", session, fetchImpl: async () => {
    ++fetches;
    return Response.json({ error: "invalid_token" }, { status: 401 });
  } });
  await assert.rejects(transport.request("api", { action: "points/update", arguments: { record_id: 7, patch: { note: "Unsaved draft" } } }),
    (error) => error instanceof CloudAuthError && error.code === "authenticationRequired");
  state.subject = "bob"; state.token = uiToken("bob");
  await assert.rejects(transport.request("api", { action: "points/update", arguments: { record_id: 7, patch: { note: "Unsaved draft" } } }), /authenticationRequired/);
  assert.equal(fetches, 1);
  assert.deepEqual(notifications, ["authenticationRequired"]);
});

test("activity routes send only timezone or bounded interaction events under the authenticated account", async () => {
  const { session } = sessionFixture();
  const calls = [];
  const transport = createCloudTransport({ apiBaseUrl: "https://memory.example", session, fetchImpl: async (url, options) => {
    calls.push({ url, options });
    return Response.json({ status: "accepted" });
  } });
  await transport.request("api", { action: "activity/read", arguments: { timezone: "America/Toronto" } });
  const event = { event_id: "00000000-0000-4000-8000-000000000001", kind: "button", occurred_at: "2026-11-24T20:00:00.000Z" };
  await transport.request("api", { action: "activity/events", arguments: { events: [event] } });
  assert.equal(calls[0].url, "https://memory.example/v1/activity?timezone=America%2FToronto");
  assert.equal(calls[0].options.method, "GET");
  assert.equal(calls[0].options.body, undefined);
  assert.equal(calls[1].url, "https://memory.example/v1/activity/events");
  assert.equal(calls[1].options.method, "POST");
  assert.deepEqual(JSON.parse(calls[1].options.body), { events: [event] });
  assert.equal(calls[1].options.headers.Authorization, "Bearer " + uiToken("alice"));
  assert.equal(calls[1].options.credentials, "omit");
  for (const args of [{ events: [] }, { events: Array(21).fill(event) }, { events: [{ ...event, text: "private note" }] },
    { events: [{ ...event, kind: "profile" }] }, { events: [{ ...event, occurred_at: "today" }] }, { events: [event], user_id: "another" }])
    await assert.rejects(transport.request("api", { action: "activity/events", arguments: args }), /invalid/);
  await assert.rejects(transport.request("api", { action: "activity/read", arguments: { timezone: "UTC", user_id: "another" } }), /invalid/);
  await assert.rejects(transport.request("api", { action: "activity/read", arguments: { timezone: "https://private.example/context" } }), /invalid/);
  assert.equal(calls.length, 2);
});

test("cloud pronunciation retrieves stored-record audio with bearer auth and no text, query, cookies or download", async () => {
  const { session } = sessionFixture();
  const calls = [];
  const transport = createCloudTransport({ apiBaseUrl: "https://memory.example", session, fetchImpl: async (url, options) => {
    calls.push({ url, options });
    return new Response(new Uint8Array([0, 128, 255]), { headers: { "Content-Type": "audio/mpeg" } });
  } });
  assert.equal(transport.capabilities.speech, true);
  const response = await transport.request("audio", { record_id: 7 });
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), new Uint8Array([0, 128, 255]));
  assert.equal(calls[0].url, "https://memory.example/v1/points/7/audio");
  assert.equal(calls[0].options.method, "GET");
  assert.equal(calls[0].options.body, undefined);
  assert.equal(calls[0].options.credentials, "omit");
  assert.equal(calls[0].options.cache, "no-store");
  assert.equal(calls[0].options.headers.Authorization, "Bearer " + uiToken("alice"));
  for (const payload of [{ record_id: "7" }, { record_id: 0 }, { record_id: 7, text: "private text" }, { record_id: 7, voice: "local" }])
    await assert.rejects(transport.request("audio", payload), /invalid/);
  assert.equal(calls.length, 1);
});

test("late cloud audio is rejected after account invalidation and a 401 pauses without retry", async () => {
  const { session } = sessionFixture();
  const pending = deferred();
  const transport = createCloudTransport({ apiBaseUrl: "https://memory.example", session, fetchImpl: () => pending.promise });
  const audio = transport.request("audio", { record_id: 7 });
  await new Promise((resolve) => setImmediate(resolve));
  session.pause("accountChanged");
  pending.resolve(new Response(new Uint8Array([1]), { headers: { "Content-Type": "audio/wav" } }));
  await assert.rejects(audio, /accountChanged/);
  const next = sessionFixture();
  let calls = 0;
  const unauthorized = createCloudTransport({ apiBaseUrl: "https://memory.example", session: next.session,
    fetchImpl: async () => { ++calls; return Response.json({ error: "invalid_token" }, { status: 401 }); },
  });
  await assert.rejects(unauthorized.request("audio", { record_id: 7 }), /authenticationRequired/);
  await assert.rejects(unauthorized.request("audio", { record_id: 7 }), /authenticationRequired/);
  assert.equal(calls, 1);
  assert.deepEqual(next.notifications, ["authenticationRequired"]);
});

test("an account change locks the previous page and rejects its late responses", async () => {
  const { session, notifications, state } = sessionFixture();
  const pending = deferred();
  const transport = createCloudTransport({ apiBaseUrl: "https://memory.example", session, fetchImpl: () => pending.promise });
  const oldPage = transport.request("api", { action: "points/query", arguments: {} });
  await new Promise((resolve) => setImmediate(resolve));
  state.subject = "bob"; state.token = uiToken("bob");
  await assert.rejects(session.getToken(), /accountChanged/);
  pending.resolve(Response.json({ records: [{ id: 7, note: "Alice's note" }] }));
  await assert.rejects(oldPage, /accountChanged/);
  assert.deepEqual(notifications, ["accountChanged"]);
  const calls = state.calls;
  await assert.rejects(session.getToken(), /accountChanged/);
  assert.equal(state.calls, calls, "a blocked page cannot silently acquire the next account's credential");
});

test("sign-out preserves failed drafts and pauses background requests only after a successful flush", async () => {
  const { session, logouts } = sessionFixture();
  assert.equal(await session.signOut(async () => false, "https://sayrove.example"), false);
  assert.equal(session.blocked, false);
  assert.equal(logouts.length, 0);
  assert.equal(await session.signOut(async () => true, "https://sayrove.example"), true);
  assert.equal(session.blocked, true);
  assert.deepEqual(logouts, [{ logoutParams: { returnTo: "https://sayrove.example" } }]);
  await assert.rejects(session.getToken(), /authenticationRequired/);
});

test("callback handling delegates PKCE/state to the SDK and removes callback details even on failure", async () => {
  const paths = [];
  let handled = 0;
  const client = { async handleRedirectCallback() { ++handled; throw new Error("invalid state and private callback detail"); } };
  await assert.rejects(completeCloudCallback(client, { pathname: "/auth/callback" }, { replaceState: (_state, _title, path) => paths.push(path) }), /invalid state/);
  assert.equal(handled, 1);
  assert.deepEqual(paths, ["/"]);
  assert.equal(await completeCloudCallback(client, { pathname: "/" }, { replaceState() { throw new Error("must not rewrite a normal page"); } }), false);
  assert.equal(handled, 1);
  const options = auth0Options({ auth0Domain: "language-memory.ca.auth0.com", auth0ClientId: "public-web-client", audience: "https://memory.example/mcp" }, "https://sayrove.example");
  assert.equal(options.cacheLocation, "memory");
  assert.equal(options.useRefreshTokens, true);
  assert.equal(options.workerUrl, "https://sayrove.example/assets/auth0-worker.js");
  assert.deepEqual(options.authorizationParams.scope.split(" "), ["openid", "memory:read", "memory:write", "offline_access"]);
});

test("cloud-only adapters cannot fall back to local export/speech or the native MCP host", async (t) => {
  const originalRuntime = globalThis.languageMemoryRuntime, originalHost = globalThis.languageMemoryHost;
  t.after(() => {
    if (originalRuntime === undefined) delete globalThis.languageMemoryRuntime; else globalThis.languageMemoryRuntime = originalRuntime;
    if (originalHost === undefined) delete globalThis.languageMemoryHost; else globalThis.languageMemoryHost = originalHost;
  });
  let cloudRequests = 0;
  globalThis.languageMemoryHost = { request() { throw new Error("native host must not receive cloud data"); } };
  globalThis.languageMemoryRuntime = {
    capabilities: { export: false, speech: false },
    async request() { ++cloudRequests; throw new CloudAuthError(); },
  };
  await assert.rejects(request("api", { action: "settings/read" }), /authenticationRequired/);
  assert.equal(cloudRequests, 1);
  assert.deepEqual(capabilities(), { export: false, speech: false });
  delete globalThis.languageMemoryRuntime;
  globalThis.languageMemoryHost = { async request() { return Response.json({ enabled: true }); } };
  assert.deepEqual(await (await request("api", { action: "settings/read" })).json(), { enabled: true });
  assert.deepEqual(capabilities(), { export: false, speech: true });
  const transport = createCloudTransport({ apiBaseUrl: "https://memory.example", session: { getToken() { throw new Error("must not request credentials"); } } });
  await assert.rejects(transport.request("export", { format: "pdf" }), /unavailable/);
  await assert.rejects(transport.request("api", { action: "speech/play", arguments: { record_id: 7 } }), /unavailable/);
});

test("public configuration validates API destinations and cloud copy stays neutral in all six languages", () => {
  const config = { appName: "Sayrove", auth0Domain: "language-memory.ca.auth0.com", auth0ClientId: "web-client",
    apiBaseUrl: "https://memory.example", audience: "https://memory.example/mcp" };
  assert.equal(validateCloudConfig(config, "https://sayrove.example").apiBaseUrl, "https://memory.example");
  for (const apiBaseUrl of ["https://user:secret@memory.example", "http://memory.example", "https://memory.example/other", "https://memory.example/?token=secret"])
    assert.throws(() => validateCloudConfig({ ...config, apiBaseUrl }, "https://sayrove.example"));
  assert.equal(detectCloudLocale(["zh-CN", "en"]), "zh");
  assert.equal(detectCloudLocale(["de-DE", "fr-CA"]), "fr");
  applyCloudMessages("Sayrove");
  assert.equal(messages.zh.appTitle, "拾语");
  assert.equal(messages.en.appTitle, "Sayrove");
  assert.doesNotMatch(JSON.stringify(messages), /codex/i);
  const keys = Object.keys(messages.en).sort();
  for (const locale of Object.keys(messages)) assert.deepEqual(Object.keys(messages[locale]).sort(), keys);
  applyCloudMessages("Custom Name");
  for (const value of Object.values(messages)) assert.equal(value.appTitle, "Custom Name");
});
