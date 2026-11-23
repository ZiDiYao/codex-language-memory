import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { CompactSign, exportJWK, generateKeyPair, SignJWT } from "jose";
import { createApp } from "../src/app.js";
import { createTokenVerifier } from "../src/auth.js";
import { loadConfig } from "../src/config.js";

const keyPair = await generateKeyPair("RS256", { extractable: true });
const publicJwk = { ...await exportJWK(keyPair.publicKey), kid: "api-test-key", alg: "RS256", use: "sig" };
const point = { kind: "word", language: "en", title: "rinse", sense_key: "clean-with-water", meaning: "用水冲洗",
  explanation: "Rinse something with water to remove soap or dirt.",
  examples: [{ text: "Rinse the cup." }, { text: "Rinse your hands with clean water." }], scenes: ["Cleaning & hygiene"] };

async function listen(server) {
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  return `http://127.0.0.1:${server.address().port}`;
}
async function close(server) {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}

/** Transport fixture only. PostgreSQL repository semantics have a separate integration suite. */
function isolatedStorage() {
  const tenants = new Map();
  let nextId = 1;
  return (principal) => {
    const key = JSON.stringify([principal.issuer, principal.subject]);
    if (!tenants.has(key)) tenants.set(key, { records: new Map(), receipts: new Map(), reviews: new Map(),
      settings: { enabled: true, ui_language: "en", first_language: null, explanation_language: null,
        enabled_types: ["word", "expression", "grammar", "correction"] } });
    const state = tenants.get(key);
    return {
      async settings(patch) { if (patch) Object.assign(state.settings, patch); return structuredClone(state.settings); },
      async save(request_id, items) {
        if (state.receipts.has(request_id)) return { ...state.receipts.get(request_id), replayed: true };
        const results = items.map((item) => {
          const id = nextId++;
          state.records.set(id, { ...structuredClone(item), id, revision: "a".repeat(64), encounter_count: 1,
            status: "new", note: item.title, note_title: item.title });
          return { status: "added", id };
        });
        const result = { results, replayed: false };
        state.receipts.set(request_id, result);
        return structuredClone(result);
      },
      async query(filters) {
        const records = [...state.records.values()].filter((record) => (!filters.kind || record.kind === filters.kind) &&
          (!filters.scene || record.scenes.includes(filters.scene)) && (!filters.language || record.language === filters.language));
        return { records: structuredClone(records), has_more: false, next_cursor: null };
      },
      async get_point(id) { return state.records.has(id) ? { status: "found", record: structuredClone(state.records.get(id)) } : { status: "not_found" }; },
      async update(id, patch, revision) {
        const record = state.records.get(id);
        if (!record) return { status: "not_found" };
        if (revision && record.revision !== revision) return { status: "failed", error: "edit_conflict", record: structuredClone(record) };
        Object.assign(record, patch, { revision: "b".repeat(64) });
        return { status: "updated", record: structuredClone(record) };
      },
      async delete(id) { return { status: state.records.delete(id) ? "deleted" : "not_found" }; },
      async scenes(filters) {
        const counts = new Map();
        for (const record of state.records.values()) if (!filters.kind || record.kind === filters.kind)
          for (const name of record.scenes) counts.set(name, (counts.get(name) ?? 0) + 1);
        return { scenes: [...counts].map(([name, count]) => ({ name, count })), total: state.records.size };
      },
      async languages() { return { languages: [...new Set([...state.records.values()].map((record) => record.language))] }; },
      async versions() { return { content: state.records.size, preferences: state.settings.enabled ? 0 : 1 }; },
      async review(filters) { return this.query(filters); },
      async record_review(id, request_id) {
        if (!state.records.has(id)) return { status: "not_found" };
        const replayed = state.reviews.has(request_id);
        state.reviews.set(request_id, true);
        return { status: "reviewed", replayed };
      },
    };
  };
}

async function fixture(t, { repositoryFactory = isolatedStorage(), readiness = async () => true, webAllowedOrigins = "" } = {}) {
  let jwksRequests = 0;
  const jwks = createServer((request, response) => {
    jwksRequests++;
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ keys: [publicJwk] }));
  });
  const issuer = await listen(jwks) + "/";
  t.after(() => close(jwks));
  let handler;
  const service = createServer((request, response) => handler(request, response));
  const base = await listen(service);
  t.after(() => close(service));
  const config = loadConfig({ DATABASE_URL: "postgresql://unused/transport-tests", PUBLIC_URL: base,
    AUTH_ISSUER: issuer, AUTH_AUDIENCE: base + "/mcp", AUTH_JWKS_URL: issuer + "jwks.json", CLOUD_ALLOW_INSECURE_LOCAL: "true",
    WEB_ALLOWED_ORIGINS: webAllowedOrigins });
  const logs = [];
  handler = createApp({ config, repositoryFactory, readiness, logger: { error: (code) => logs.push(code) } });
  async function token(subject = "alice", overrides = {}, { privateKey = keyPair.privateKey, header = {} } = {}) {
    return new SignJWT({ iss: issuer, sub: subject, aud: config.authAudience, exp: Math.floor(Date.now() / 1000) + 300,
      iat: Math.floor(Date.now() / 1000) - 1, scope: "memory:read memory:write", ...overrides })
      .setProtectedHeader({ alg: "RS256", kid: "api-test-key", ...header }).sign(privateKey);
  }
  async function call(path, { subject = "alice", authorization, method = "GET", body, headers = {} } = {}) {
    const response = await fetch(base + path, { method, headers: { Authorization: authorization ?? `Bearer ${await token(subject)}`,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await response.text();
    return { status: response.status, headers: response.headers, body: text ? JSON.parse(text) : null };
  }
  async function rpc(name = "tools/list", params = {}, subject = "alice") {
    return call("/mcp", { subject, method: "POST", headers: { Accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2025-03-26" },
      body: { jsonrpc: "2.0", id: 1, method: name, params } });
  }
  return { base, config, token, call, rpc, logs, get jwksRequests() { return jwksRequests; } };
}

test("cloud configuration rejects missing/HTTP/non-PostgreSQL settings without anonymous fallback", () => {
  assert.throws(() => loadConfig({}), /Missing required configuration/);
  const env = { DATABASE_URL: "postgresql://user:password@db/memory", PUBLIC_URL: "https://memory.example",
    AUTH_ISSUER: "https://issuer.example/", AUTH_AUDIENCE: "memory", AUTH_JWKS_URL: "https://issuer.example/jwks" };
  assert.equal(loadConfig(env).port, 8080);
  assert.throws(() => loadConfig({ ...env, PUBLIC_URL: "http://memory.example" }), /HTTPS/);
  assert.throws(() => loadConfig({ ...env, DATABASE_URL: "sqlite:///memory.db" }), /PostgreSQL/);
  assert.throws(() => loadConfig({ ...env, AUTH_REQUIRED_SCOPES: "" }), /scope/);
  assert.throws(() => loadConfig({ ...env, CLOUD_ALLOW_INSECURE_LOCAL: "true", AUTH_ISSUER: "http://untrusted.example" }), /HTTPS/);
});

test("Web origin configuration accepts only explicit origins and defaults to no external browser access", () => {
  const env = { DATABASE_URL: "postgresql://unused/db", PUBLIC_URL: "https://memory.example",
    AUTH_ISSUER: "https://issuer.example/", AUTH_AUDIENCE: "memory", AUTH_JWKS_URL: "https://issuer.example/jwks" };
  assert.deepEqual(loadConfig(env).webAllowedOrigins, []);
  assert.deepEqual(loadConfig({ ...env, WEB_ALLOWED_ORIGINS: " https://web.example,https://second.example:8443,https://web.example " }).webAllowedOrigins,
    ["https://web.example", "https://second.example:8443"]);
  for (const value of ["*", "null", "https://*.example", "https://web.example/", "https://web.example/path",
    "https://web.example?x=1", "https://web.example#x", "https://user:pass@web.example", "https://web.example,",
    "http://web.example", "http://127.0.0.1:3000", "http://localhost:3000", "file:///tmp/web", 42])
    assert.throws(() => loadConfig({ ...env, WEB_ALLOWED_ORIGINS: value }), /WEB_ALLOWED_ORIGINS/);
  assert.deepEqual(loadConfig({ ...env, CLOUD_ALLOW_INSECURE_LOCAL: "true", WEB_ALLOWED_ORIGINS: "http://127.0.0.1:3000,http://localhost:3000" }).webAllowedOrigins,
    ["http://127.0.0.1:3000", "http://localhost:3000"]);
  assert.throws(() => loadConfig({ ...env, CLOUD_ALLOW_INSECURE_LOCAL: "true", WEB_ALLOWED_ORIGINS: "http://web.example" }), /WEB_ALLOWED_ORIGINS/);
});

test("Web CORS preflight is unauthenticated, path/method/header bounded, and exclusive to REST", async (t) => {
  const origin = "https://web.example";
  const service = await fixture(t, { webAllowedOrigins: origin });
  const preflight = (path, method = "GET", requestedHeaders = "Authorization, Content-Type", extra = {}) => service.call(path, {
    method: "OPTIONS", authorization: "", headers: { Origin: origin, "Access-Control-Request-Method": method,
      "Access-Control-Request-Headers": requestedHeaders, ...extra },
  });
  for (const [path, method, methods] of [["/v1/settings", "PATCH", "GET, PATCH"], ["/v1/captures", "POST", "POST"],
    ["/v1/points/23", "DELETE", "GET, PATCH, DELETE"], ["/v1/languages", "GET", "GET"], ["/v1/changes", "GET", "GET"]]) {
    const result = await preflight(path, method);
    assert.equal(result.status, 204);
    assert.equal(result.body, null);
    assert.equal(result.headers.get("access-control-allow-origin"), origin);
    assert.equal(result.headers.get("access-control-allow-methods"), methods);
    assert.equal(result.headers.get("access-control-allow-headers"), "Authorization, Content-Type");
    assert.equal(result.headers.get("access-control-allow-credentials"), null);
    assert.match(result.headers.get("vary"), /Origin/);
    assert.equal(result.headers.get("www-authenticate"), null);
  }
  assert.equal(service.jwksRequests, 0, "preflight must not authenticate or read storage");
  assert.equal((await preflight("/v1/missing")).status, 403);
  assert.equal((await preflight("/v1/points/not-an-id")).status, 403);
  assert.equal((await preflight("/v1/points", "DELETE")).status, 405);
  assert.equal((await preflight("/v1/settings", "PUT")).status, 405);
  for (const headers of ["X-User-ID", "Authorization, X-User-ID", "Authorization,", "Authorization, authorization"])
    assert.equal((await preflight("/v1/points", "GET", headers)).status, 400);
  assert.equal((await service.call("/v1/settings", { method: "OPTIONS", authorization: "", headers: { Origin: origin } })).status, 405);
  assert.equal((await service.call("/v1/settings", { method: "OPTIONS", authorization: "" })).status, 403);
  for (const path of ["/mcp", "/healthz", "/readyz", "/.well-known/oauth-protected-resource/mcp"]) {
    const result = await preflight(path);
    assert.equal(result.status, 403);
    assert.equal(result.headers.get("access-control-allow-origin"), null);
  }
});

test("Trusted Web origins can read REST JWT/validation errors; origin and Host protections remain exact", async (t) => {
  const origin = "https://web.example";
  const service = await fixture(t, { webAllowedOrigins: origin });
  for (const [path, options, status] of [["/v1/settings", { authorization: "" }, 401],
    ["/v1/settings", { authorization: "Bearer invalid" }, 401], ["/v1/points?user_id=bob", {}, 422],
    ["/v1/points/999", {}, 404], ["/v1/settings", { method: "POST" }, 405]]) {
    const result = await service.call(path, { ...options, headers: { Origin: origin } });
    assert.equal(result.status, status);
    assert.equal(result.headers.get("access-control-allow-origin"), origin);
    assert.match(result.headers.get("vary"), /Origin/);
    assert.equal(result.headers.get("access-control-allow-credentials"), null);
  }
  const trusted = await service.call("/v1/settings", { headers: { Origin: origin } });
  assert.equal(trusted.status, 200);
  const insufficient = await service.call("/v1/points", { headers: { Origin: origin },
    authorization: `Bearer ${await service.token("alice", { scope: "memory:read" })}` });
  assert.equal(insufficient.status, 403);
  assert.equal(insufficient.headers.get("access-control-allow-origin"), origin);
  const saved = await service.call("/v1/captures", { method: "POST", body: { request_id: "cors-conflict", items: [point] } });
  const id = saved.body.results[0].id;
  await service.call(`/v1/points/${id}`, { method: "PATCH", body: { patch: { note: "New note" }, expected_revision: "a".repeat(64) } });
  const conflict = await service.call(`/v1/points/${id}`, { method: "PATCH", headers: { Origin: origin },
    body: { patch: { note: "Stale note" }, expected_revision: "a".repeat(64) } });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.headers.get("access-control-allow-origin"), origin);
  for (const rejected of ["https://web.example.evil", "https://evil.web.example", "https://web.example:8443", "null", "https://other.example"]) {
    const result = await service.call("/v1/settings", { headers: { Origin: rejected } });
    assert.equal(result.status, 403);
    assert.equal(result.headers.get("access-control-allow-origin"), null);
  }
  const disabled = await fixture(t);
  assert.equal((await disabled.call("/v1/settings", { headers: { Origin: origin } })).status, 403);
  for (const path of ["/mcp", "/healthz", "/readyz", "/.well-known/oauth-protected-resource/mcp"])
    assert.equal((await service.call(path, { headers: { Origin: origin } })).status, 403);
  const broken = await fixture(t, { webAllowedOrigins: origin, repositoryFactory: () => ({ async settings() { throw new Error("private-db-data"); } }) });
  const unavailable = await broken.call("/v1/settings", { headers: { Origin: origin } });
  assert.equal(unavailable.status, 503);
  assert.deepEqual(unavailable.body, { error: "unavailable" });
  assert.equal(unavailable.headers.get("access-control-allow-origin"), origin);
  const badHost = await new Promise((resolve, reject) => {
    const request = httpRequest(service.base + "/v1/settings", { headers: { Host: "attacker.example", Origin: origin } }, (response) => {
      response.resume(); response.once("end", () => resolve({ status: response.statusCode, origin: response.headers["access-control-allow-origin"] }));
    });
    request.once("error", reject); request.end();
  });
  assert.deepEqual(badHost, { status: 403, origin: undefined });
});

test("Languages and changes routes use only the verified tenant and reject anonymous access", async (t) => {
  const { call } = await fixture(t);
  for (const path of ["/v1/languages", "/v1/changes"]) {
    assert.equal((await call(path, { authorization: "" })).status, 401);
    assert.equal((await call(path + "?user_id=bob")).status, 422);
    assert.equal((await call(path, { method: "POST" })).status, 405);
  }
  await call("/v1/captures", { method: "POST", body: { request_id: "catalog-alice", items: [point] } });
  assert.deepEqual((await call("/v1/languages")).body.languages, ["en"]);
  assert.deepEqual((await call("/v1/languages", { subject: "bob" })).body.languages, []);
  assert.equal((await call("/v1/changes")).body.content, 1);
  assert.equal((await call("/v1/changes", { subject: "bob" })).body.content, 0);
  await call("/v1/settings", { method: "PATCH", body: { enabled: false } });
  assert.equal((await call("/v1/changes")).body.preferences, 1);
  assert.equal((await call("/v1/changes", { subject: "bob" })).body.preferences, 0);
});

test("real JWKS/RSA authentication, metadata, health and scope enforcement", async (t) => {
  const service = await fixture(t);
  assert.equal((await service.call("/healthz", { authorization: "" })).status, 200);
  assert.equal((await service.call("/readyz", { authorization: "" })).status, 200);
  const metadata = await service.call("/.well-known/oauth-protected-resource/mcp", { authorization: "" });
  assert.equal(metadata.body.resource, service.config.resourceUrl);
  assert.deepEqual(metadata.body.authorization_servers, [service.config.authIssuer]);
  for (const path of ["/v1/settings", "/v1/points", "/v1/scenes", "/v1/review-queue", "/v1/points/1"])
    assert.equal((await service.call(path, { authorization: "" })).status, 401);
  const missing = await service.call("/mcp", { method: "POST", authorization: "", body: {} });
  assert.equal(missing.status, 401);
  assert.match(missing.headers.get("www-authenticate"), /resource_metadata=/);
  assert.equal((await service.call("/v1/settings")).status, 200);
  assert.ok(service.jwksRequests >= 1, "the real key endpoint was requested");
  const insufficient = await service.call("/v1/points", { authorization: `Bearer ${await service.token("alice", { scope: "memory:read" })}` });
  assert.equal(insufficient.status, 403);
});

test("signed JWTs with wrong signatures, issuer, audience, time, subject and malformed expiry are rejected", async (t) => {
  const service = await fixture(t);
  const wrongKeys = await generateKeyPair("RS256");
  const candidates = [await service.token("alice", {}, { privateKey: wrongKeys.privateKey })];
  for (const claims of [{ iss: "https://attacker.example" }, { aud: "another-api" }, { exp: 1 }, { sub: "" },
    { exp: "9999999999" }, { exp: true }, { exp: null }, { nbf: Math.floor(Date.now() / 1000) + 300 }])
    candidates.push(await service.token("alice", claims));
  const valid = { iss: service.config.authIssuer, sub: "alice", aud: service.config.authAudience,
    exp: Math.floor(Date.now() / 1000) + 300, scope: "memory:read memory:write" };
  for (const claim of ["iss", "sub", "aud", "exp"]) {
    const payload = { ...valid }; delete payload[claim];
    candidates.push(await new SignJWT(payload).setProtectedHeader({ alg: "RS256", kid: "api-test-key" }).sign(keyPair.privateKey));
  }
  const infinite = JSON.stringify({ ...valid, exp: "EXP_PLACEHOLDER" }).replace('"EXP_PLACEHOLDER"', "1e309");
  candidates.push(await new CompactSign(Buffer.from(infinite)).setProtectedHeader({ alg: "RS256", kid: "api-test-key" }).sign(keyPair.privateKey));
  for (const jwt of candidates) assert.equal((await service.call("/v1/points", { authorization: `Bearer ${jwt}` })).status, 401);
  const symmetric = await new SignJWT(valid).setProtectedHeader({ alg: "HS256", kid: "api-test-key" }).sign(new Uint8Array(32));
  assert.equal((await service.call("/v1/points", { authorization: `Bearer ${symmetric}` })).status, 401);
  const unsigned = Buffer.from('{"alg":"none","kid":"api-test-key"}').toString("base64url") + "." + Buffer.from(JSON.stringify(valid)).toString("base64url") + ".";
  assert.equal((await service.call("/v1/points", { authorization: `Bearer ${unsigned}` })).status, 401);
  const jku = await service.token("alice", {}, { header: { jku: "http://127.0.0.1:1/attacker-jwks" } });
  assert.equal((await service.call("/v1/points", { authorization: `Bearer ${jku}` })).status, 200);
  const verifier = createTokenVerifier(service.config, { jwks: async () => { throw new Error("provider detail must not leak"); } });
  await assert.rejects(() => verifier(jku), (error) => error.status === 401 && error.message === "invalid_token");
});

test("REST records, retries, edits, scenes and reviews remain isolated by verified principal", async (t) => {
  const { call } = await fixture(t);
  const body = { request_id: "capture-once", items: [point] };
  const saved = await call("/v1/captures", { method: "POST", body });
  assert.equal(saved.status, 200);
  const id = saved.body.results[0].id;
  assert.equal((await call("/v1/captures", { method: "POST", body })).body.replayed, true);
  assert.deepEqual((await call("/v1/points", { subject: "bob" })).body.records, []);
  for (const method of ["GET", "PATCH", "DELETE"])
    assert.equal((await call(`/v1/points/${id}`, { method, subject: "bob", ...(method === "PATCH" ? { body: { patch: { note: "stolen" } } } : {}) })).status, 404);
  const original = (await call(`/v1/points/${id}`)).body.record;
  const update = await call(`/v1/points/${id}`, { method: "PATCH", body: { patch: { note: "My rinse note" }, expected_revision: original.revision } });
  assert.equal(update.status, 200);
  assert.equal((await call(`/v1/points/${id}`, { method: "PATCH", body: { patch: { note: "stale" }, expected_revision: original.revision } })).status, 409);
  assert.equal((await call("/v1/scenes")).body.scenes[0].name, "Cleaning & hygiene");
  const filtered = await call("/v1/points?scene=Cleaning%20%26%20hygiene&kind=word");
  assert.deepEqual(filtered.body.records.map((record) => record.id), [id]);
  const review = { record_id: id, request_id: "review-once", review: { result: "correct", answer: "冲洗" } };
  assert.equal((await call("/v1/reviews", { method: "POST", subject: "bob", body: review })).status, 404);
  assert.equal((await call("/v1/reviews", { method: "POST", body: review })).status, 200);
  assert.equal((await call("/v1/reviews", { method: "POST", body: review })).body.replayed, true);
  await call("/v1/settings", { method: "PATCH", body: { enabled: false } });
  assert.equal((await call("/v1/settings", { subject: "bob" })).body.enabled, true);
  assert.equal((await call("/v1/points?user_id=bob")).status, 422);
  assert.equal((await call("/v1/settings", { method: "PATCH", body: { user_id: "bob" } })).status, 422);
});

test("fresh stateless MCP requests initialize/list/call and concurrent users never share tool responses", async (t) => {
  const { rpc, call } = await fixture(t);
  const init = await rpc("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "api-tests", version: "1" } });
  assert.equal(init.status, 200);
  assert.ok(init.body.result.serverInfo);
  assert.equal(init.headers.get("mcp-session-id"), null);
  const tools = await rpc();
  assert.equal(tools.status, 200);
  assert.equal(tools.body.result.tools.length, 12);
  assert.ok(tools.body.result.tools.some((tool) => tool.name === "save_points"));
  assert.ok(!tools.body.result.tools.some((tool) => ["export_points", "start_study", "open_memory_page"].includes(tool.name)));
  const saved = await rpc("tools/call", { name: "save_points", arguments: { request_id: "mcp-capture-once", items: [point] } });
  assert.equal(saved.body.result.structuredContent.results[0].status, "added");
  assert.equal((await call("/v1/points")).body.records.length, 1);
  const found = await Promise.all(Array.from({ length: 20 }, (_, index) => rpc("tools/call", { name: "find_points", arguments: {} }, index % 2 ? "bob" : "alice")));
  found.forEach((response, index) => {
    assert.equal(response.status, 200);
    assert.equal(response.body.result.structuredContent.records.length, index % 2 ? 0 : 1);
    assert.equal(response.headers.get("mcp-session-id"), null);
  });
});

test("host/origin, bounded bodies, duplicate queries and failed DB operations return safe errors", async (t) => {
  const { base, call, token } = await fixture(t);
  assert.equal((await call("/v1/points", { headers: { Origin: "https://attacker.example" } })).status, 403);
  const badHost = await new Promise((resolve, reject) => {
    const request = httpRequest(base + "/v1/points", { headers: { Host: "attacker.example" } }, (response) => {
      response.resume(); response.once("end", () => resolve(response.statusCode));
    });
    request.once("error", reject); request.end();
  });
  assert.equal(badHost, 403);
  assert.equal((await call("/v1/points?language=en&language=fr")).status, 422);
  assert.equal((await call("/v1/captures", { method: "POST", body: { large: "x".repeat(1024 * 1024) } })).status, 413);
  const chunked = await new Promise((resolve, reject) => {
    token().then((jwt) => {
      const request = httpRequest(base + "/v1/captures", { method: "POST", headers: { Authorization: `Bearer ${jwt}`, "Content-Type": "application/json", "Transfer-Encoding": "chunked" } }, (response) => {
        response.resume(); response.once("end", () => resolve(response.statusCode));
      });
      request.once("error", reject);
      request.write('{"large":"'); request.write("x".repeat(1024 * 1024)); request.end('"}');
    }, reject);
  });
  assert.equal(chunked, 413);
  const broken = await fixture(t, { repositoryFactory: () => ({ async query() { throw new Error("secret-note-and-password"); } }), readiness: async () => false });
  assert.equal((await broken.call("/readyz", { authorization: "" })).status, 503);
  const failure = await broken.call("/v1/points");
  assert.equal(failure.status, 503);
  assert.deepEqual(failure.body, { error: "unavailable" });
  const mcpFailure = await broken.rpc("tools/call", { name: "find_points", arguments: {} });
  assert.deepEqual(mcpFailure.body.result.structuredContent, { status: "failed", error: "unavailable" });
  assert.deepEqual(broken.logs, ["cloud_repository_failed", "cloud_repository_failed"]);
});

test("Railway health probes accept only the exact platform Host on GET health routes", async (t) => {
  const { base, token } = await fixture(t);
  const authorization = `Bearer ${await token()}`;
  async function probe(path, { host = "healthcheck.railway.app", method = "GET", origin } = {}) {
    return new Promise((resolve, reject) => {
      const request = httpRequest(base + path, { method, headers: {
        Host: host, Authorization: authorization, ...(origin === undefined ? {} : { Origin: origin }),
      } }, (response) => {
        response.resume();
        response.once("end", () => resolve(response.statusCode));
      });
      request.once("error", reject);
      request.end();
    });
  }
  assert.equal(await probe("/healthz"), 200);
  assert.equal(await probe("/readyz"), 200);
  assert.equal(await probe("/v1/points"), 403);
  assert.equal(await probe("/mcp", { method: "POST" }), 403);
  assert.equal(await probe("/readyz", { method: "POST" }), 403);
  for (const host of ["evil.healthcheck.railway.app", "healthcheck.railway.app.evil.example", "healthcheck.railway.app."])
    assert.equal(await probe("/readyz", { host }), 403);
  assert.equal(await probe("/readyz", { origin: "https://attacker.example" }), 403);
  assert.equal(await probe("/healthz", { origin: "null" }), 403);
});

test("real PostgreSQL repository shares authenticated HTTP/MCP storage without crossing users", {
  skip: !process.env.TEST_DATABASE_URL,
}, async (t) => {
  const { createPool, checkSchema } = await import("../src/database.js");
  const { migrate } = await import("../src/migration.js");
  const { Repository } = await import("../src/repository.js");
  const admin = createPool(process.env.TEST_DATABASE_URL);
  const schema = "node_api_" + randomUUID().replaceAll("-", "");
  let pool;
  t.after(async () => {
    await pool?.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  });
  await admin.query(`CREATE SCHEMA ${schema}`);
  pool = createPool(process.env.TEST_DATABASE_URL, { options: `-c search_path=${schema}` });
  await migrate(pool);
  const service = await fixture(t, { repositoryFactory: (principal) => new Repository(pool, principal), readiness: () => checkSchema(pool) });
  assert.equal((await service.call("/readyz", { authorization: "" })).status, 200);
  const saved = await service.rpc("tools/call", { name: "save_points", arguments: { request_id: "real-pg-capture", items: [point] } });
  assert.equal(saved.body.result.structuredContent.results[0].status, "added");
  const id = saved.body.result.structuredContent.results[0].id;
  assert.equal((await service.call("/v1/points")).body.records.length, 1);
  assert.deepEqual((await service.call("/v1/languages")).body.languages, ["en"]);
  assert.deepEqual((await service.call("/v1/languages", { subject: "bob" })).body.languages, []);
  const aliceVersions = (await service.call("/v1/changes")).body;
  const bobVersions = (await service.call("/v1/changes", { subject: "bob" })).body;
  assert.equal(aliceVersions.content, 1);
  assert.deepEqual(bobVersions, { content: 0, preferences: 0 });
  await service.call("/v1/settings", { method: "PATCH", body: { ui_language: "zh" } });
  assert.equal((await service.call("/v1/changes")).body.preferences, 1);
  assert.equal((await service.call("/v1/changes", { subject: "bob" })).body.preferences, 0);
  assert.deepEqual((await service.call("/v1/points", { subject: "bob" })).body.records, []);
  assert.equal((await service.call(`/v1/points/${id}`, { subject: "bob", method: "DELETE" })).status, 404);
  const bob = await service.rpc("tools/call", { name: "find_points", arguments: {} }, "bob");
  assert.deepEqual(bob.body.result.structuredContent.records, []);
  const repeated = await service.call("/v1/captures", { method: "POST", body: { request_id: "real-pg-capture", items: [point] } });
  assert.equal(repeated.body.replayed, true);
  assert.equal((await service.call("/v1/points")).body.records[0].encounter_count, 1);
});
