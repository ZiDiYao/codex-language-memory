import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { createTokenVerifier } from '../src/auth.js';
import { createSpeechService } from '../src/speech.js';

const keys = await generateKeyPair('RS256', { extractable: true });
const jwks = createLocalJWKSet({ keys: [{ ...await exportJWK(keys.publicKey), kid: 'speech-api-key', alg: 'RS256' }] });
function wave() {
  const bytes = Buffer.alloc(48);
  bytes.write('RIFF'); bytes.writeUInt32LE(40, 4); bytes.write('WAVE', 8);
  bytes.write('fmt ', 12); bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22); bytes.writeUInt32LE(24000, 24); bytes.writeUInt32LE(48000, 28);
  bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34); bytes.write('data', 36); bytes.writeUInt32LE(4, 40);
  return bytes;
}

async function fixture(t, { enabled = true, fetchImpl } = {}) {
  const records = new Map([['alice', new Map([[1, { id: 1, title: 'historical', note_title: 'secure', language: 'en' }]])],
    ['bob', new Map([[2, { id: 2, title: 'bank', note_title: 'personal bank', language: 'en' }]])]]);
  let calls = 0;
  const requests = [], logs = [];
  const speech = createSpeechService({ provider: enabled ? 'deepseek' : 'disabled', apiKey: 'fixture-only-key', voice: 'stella',
    fetchImpl: fetchImpl ?? (async (url, init) => {
      calls++; requests.push({ url, body: JSON.parse(init.body) });
      return new Response(wave(), { headers: { 'Content-Type': 'audio/wav', 'Content-Length': '48' } });
    }) });
  let handler;
  const server = createServer((request, response) => handler(request, response));
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const config = loadConfig({ DATABASE_URL: 'postgresql://unused/speech-tests', PUBLIC_URL: base,
    AUTH_ISSUER: 'https://identity.example/', AUTH_AUDIENCE: base + '/mcp', AUTH_JWKS_URL: 'https://identity.example/jwks',
    CLOUD_ALLOW_INSECURE_LOCAL: 'true', WEB_ALLOWED_ORIGINS: 'https://learn.example' });
  handler = createApp({ config, speech, verifyToken: createTokenVerifier(config, { jwks }),
    repositoryFactory: principal => ({
      async get_point(id) { const record = records.get(principal.subject)?.get(id); return record ? { status: 'found', record: structuredClone(record) } : { status: 'not_found' }; },
      async settings() { return { enabled: true }; },
    }), logger: { error: code => logs.push(code) } });
  t.after(async () => { speech.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  async function token(subject = 'alice', scope = 'memory:read memory:write') {
    return new SignJWT({ iss: config.authIssuer, sub: subject, aud: config.authAudience, scope,
      exp: Math.floor(Date.now() / 1000) + 120 }).setProtectedHeader({ alg: 'RS256', kid: 'speech-api-key' }).sign(keys.privateKey);
  }
  async function call(path = '/v1/points/1/audio', { subject = 'alice', scope, authorization, headers = {}, ...rest } = {}) {
    return fetch(base + path, { ...rest, headers: { Authorization: authorization ?? `Bearer ${await token(subject, scope)}`, ...headers } });
  }
  return { base, records, speech, call, logs, requests, token, get calls() { return calls; } };
}

test('cloud pronunciation authorizes the record, returns audio bytes, and caches only within the tenant', async t => {
  const f = await fixture(t);
  let reply = await f.call();
  assert.equal(reply.status, 200); assert.equal(reply.headers.get('content-type'), 'audio/wav');
  assert.equal(reply.headers.get('cache-control'), 'private, no-store');
  assert.equal(reply.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(reply.headers.get('x-sayrove-speech-source'), 'ai');
  assert.deepEqual(Buffer.from(await reply.arrayBuffer()), wave());
  assert.equal(f.requests[0].body.text, 'secure');
  reply = await f.call(); await reply.arrayBuffer(); assert.equal(f.calls, 1);
  reply = await f.call('/v1/points/1/audio', { subject: 'bob' });
  assert.equal(reply.status, 404); assert.equal(f.calls, 1);
  assert.deepEqual(await reply.json(), { error: 'not_found' });
  f.records.get('bob').set(1, { id: 1, title: 'secure', note_title: 'secure', language: 'en' });
  reply = await f.call('/v1/points/1/audio', { subject: 'bob' }); await reply.arrayBuffer();
  assert.equal(f.calls, 2, 'identical text in another verified tenant does not share private cache entries');
  f.records.get('alice').get(1).note_title = 'secure a job';
  reply = await f.call(); await reply.arrayBuffer(); assert.equal(f.calls, 3);
  assert.equal(f.requests.at(-1).body.text, 'secure a job');
  f.records.get('alice').delete(1);
  reply = await f.call(); assert.equal(reply.status, 404); assert.equal(f.calls, 3);
  assert.deepEqual(f.logs, []);
});

test('speech errors remain authenticated, origin restricted, and cannot accept arbitrary text or URL inputs', async t => {
  const f = await fixture(t);
  for (const options of [{ authorization: '' }, { scope: 'memory:read' }]) {
    const response = await f.call(undefined, options);
    assert.equal(response.status, options.authorization === '' ? 401 : 403);
  }
  assert.equal((await f.call(undefined, { headers: { Origin: 'https://evil.example' } })).status, 403);
  assert.equal((await f.call('/v1/points/1/audio?text=untrusted')).status, 422);
  assert.equal((await f.call('/v1/points/1/audio?url=https://evil.example')).status, 422);
  assert.equal((await f.call('/v1/points/0/audio')).status, 422);
  assert.equal((await f.call('/v1/points/9007199254740992/audio')).status, 422);
  assert.equal((await f.call(undefined, { method: 'POST' })).status, 405);
  assert.equal(f.calls, 0);
  const preflight = await fetch(f.base + '/v1/points/1/audio', { method: 'OPTIONS', headers: {
    Origin: 'https://learn.example', 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'authorization',
  } });
  assert.equal(preflight.status, 204); assert.equal(preflight.headers.get('access-control-allow-origin'), 'https://learn.example');
  const valid = await f.call(undefined, { headers: { Origin: 'https://learn.example' } });
  assert.equal(valid.status, 200); assert.equal(valid.headers.get('access-control-allow-origin'), 'https://learn.example');
  await valid.arrayBuffer();
});

test('unconfigured speech is visibly unavailable without a local voice or a fabricated audio response', async t => {
  const f = await fixture(t, { enabled: false });
  const settings = await f.call('/v1/settings');
  assert.equal((await settings.json())._capabilities.cloud_speech, false);
  const response = await f.call();
  assert.equal(response.status, 503); assert.deepEqual(await response.json(), { error: 'speech_unavailable' });
  assert.equal(f.calls, 0);
});

test('provider failures expose a stable code and never return upstream secrets as audio', async t => {
  const f = await fixture(t, { fetchImpl: async () => new Response('private-provider-key-and-error', { status: 503 }) });
  const response = await f.call();
  assert.equal(response.status, 503); assert.deepEqual(await response.json(), { error: 'speech_unavailable' });
  assert.deepEqual(f.logs, []);
});

test('a disconnected audio client cancels its provider work', async t => {
  let started, upstream;
  const entered = new Promise(resolve => { started = resolve; });
  const f = await fixture(t, { fetchImpl: async (_url, init) => {
    upstream = init.signal; started();
    return new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
  } });
  const controller = new AbortController();
  const response = f.call(undefined, { signal: controller.signal });
  await entered; controller.abort();
  await assert.rejects(response, error => error.name === 'AbortError');
  for (let attempt = 0; attempt < 20 && !upstream.aborted; attempt++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(upstream.aborted, true);
});
