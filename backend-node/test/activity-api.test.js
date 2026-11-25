import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer, request as httpRequest } from 'node:http';
import { randomUUID } from 'node:crypto';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { createTokenVerifier } from '../src/auth.js';
import { readActivity } from '../src/activity.js';

const keys = await generateKeyPair('RS256', { extractable: true });
const jwks = createLocalJWKSet({ keys: [{ ...await exportJWK(keys.publicKey), kid: 'activity-fixture', alg: 'RS256' }] });
async function fixture(t) {
  let handler;
  const server = createServer((request, response) => handler(request, response));
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const config = loadConfig({ DATABASE_URL: 'postgresql://unused/activity-fixture', PUBLIC_URL: base,
    AUTH_ISSUER: 'https://issuer.example/', AUTH_AUDIENCE: base + '/mcp', AUTH_JWKS_URL: 'https://issuer.example/jwks',
    CLOUD_ALLOW_INSECURE_LOCAL: 'true', WEB_ALLOWED_ORIGINS: 'https://learn.example' });
  const calls = [], logs = [];
  handler = createApp({ config, verifyToken: createTokenVerifier(config, { jwks }), logger: { error: code => logs.push(code) },
    repositoryFactory: principal => ({
      async settings() { return { enabled: true }; },
      async activity(query) { calls.push({ principal, method: 'read', query }); return readActivity({ query: async () => ({ rows: [] }) }, 'fixture', query); },
      async activity_events(events) { calls.push({ principal, method: 'events', events }); return { status: 'ok', accepted: events.length, duplicate: 0, throttled: 0 }; },
    }) });
  async function token(subject = 'alice', scope = 'memory:read memory:write') {
    return new SignJWT({ iss: config.authIssuer, sub: subject, aud: config.authAudience, scope,
      exp: Math.floor(Date.now() / 1000) + 120 }).setProtectedHeader({ alg: 'RS256', kid: 'activity-fixture' }).sign(keys.privateKey);
  }
  async function call(path = '/v1/activity', { subject, scope, authorization, body, headers = {}, ...options } = {}) {
    return fetch(base + path, { ...options, headers: { Authorization: authorization ?? `Bearer ${await token(subject, scope)}`,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  }
  return { base, call, calls, logs, token };
}
const event = () => ({ event_id: randomUUID(), kind: 'pronunciation', occurred_at: new Date().toISOString() });

test('activity REST reads and batches use the verified tenant without adding foreground MCP tools', async t => {
  const f = await fixture(t);
  const reply = await f.call('/v1/activity?timezone=America%2FToronto', { subject: 'alice' });
  assert.equal(reply.status, 200); assert.equal(reply.headers.get('cache-control'), 'no-store');
  const data = await reply.json(); assert.equal(data.days.length, 182); assert.equal(data.timezone, 'America/Toronto');
  assert.equal(data.totals.learning_count, 0); assert.equal(data.totals.interaction_count, 0);
  const events = [event()];
  const saved = await f.call('/v1/activity/events', { method: 'POST', subject: 'bob', body: { events } });
  assert.equal(saved.status, 200); assert.deepEqual(await saved.json(), { status: 'ok', accepted: 1, duplicate: 0, throttled: 0 });
  assert.equal(f.calls[0].principal.subject, 'alice'); assert.equal(f.calls[1].principal.subject, 'bob');
  assert.deepEqual(f.calls[1].events, events);
  assert.equal((await (await f.call('/v1/settings')).json())._capabilities.activity, true);
  assert.deepEqual(f.logs, []);
});

test('activity endpoints reject missing scopes, unknown input, request bodies on GET and unsupported origins/methods', async t => {
  const f = await fixture(t);
  for (const path of ['/v1/activity', '/v1/activity/events']) {
    const method = path.endsWith('events') ? 'POST' : 'GET';
    const body = method === 'POST' ? { events: [event()] } : undefined;
    assert.equal((await f.call(path, { method, body, authorization: '' })).status, 401);
    assert.equal((await f.call(path, { method, body, scope: 'memory:read' })).status, 403);
    assert.equal((await f.call(path, { method, body, headers: { Origin: 'https://evil.example' } })).status, 403);
  }
  for (const query of ['?timezone=invalid', '?timezone=UTC&timezone=UTC', '?tenant_id=other', '?days=100000'])
    assert.equal((await f.call('/v1/activity' + query)).status, 422);
  for (const body of [{ events: [event()], user_id: 'other' }, { events: [event(), { ...event(), record_id: 1 }] },
    { events: [] }, { events: Array.from({ length: 21 }, event) }])
    assert.equal((await f.call('/v1/activity/events', { method: 'POST', body })).status, 422);
  assert.equal((await f.call('/v1/activity/events?timezone=UTC', { method: 'POST', body: { events: [event()] } })).status, 422);
  assert.equal((await f.call('/v1/activity/events')).status, 405);
  assert.equal((await f.call('/v1/activity', { method: 'POST', body: {} })).status, 405);
  assert.equal((await f.call('/v1/activity/events', { method: 'POST', body: { padding: 'x'.repeat(8192) } })).status, 413);
  assert.equal((await f.call('/v1/activity/events', { method: 'POST', body: { events: [event()] }, headers: { 'Content-Type': 'text/plain' } })).status, 415);
  const authorization = `Bearer ${await f.token()}`;
  const getWithBody = await new Promise((resolve, reject) => {
    const request = httpRequest(f.base + '/v1/activity', { method: 'GET', headers: {
      Authorization: authorization, 'Content-Type': 'application/json', 'Content-Length': '2',
    } }, response => { response.resume(); response.on('end', () => resolve(response.statusCode)); });
    request.on('error', reject); request.end('{}');
  });
  assert.equal(getWithBody, 422);
  assert.equal(f.calls.length, 0);
});

test('trusted web activity requests receive narrowly scoped CORS, including safe validation errors', async t => {
  const f = await fixture(t);
  const headers = { Origin: 'https://learn.example' };
  const preflight = await fetch(f.base + '/v1/activity/events', { method: 'OPTIONS', headers: { ...headers,
    'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'Authorization, Content-Type' } });
  assert.equal(preflight.status, 204); assert.equal(preflight.headers.get('access-control-allow-methods'), 'POST');
  const valid = await f.call('/v1/activity', { headers });
  assert.equal(valid.headers.get('access-control-allow-origin'), headers.Origin);
  const invalid = await f.call('/v1/activity?timezone=unknown', { headers });
  assert.equal(invalid.status, 422); assert.equal(invalid.headers.get('access-control-allow-origin'), headers.Origin);
  assert.deepEqual(await invalid.json(), { error: 'invalid_request' });
});
