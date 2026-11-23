#!/usr/bin/env node
/** Real loopback HTTP + JWT + PostgreSQL timings. Never uses production accounts. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomUUID, createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { createApp } from '../backend-node/src/app.js';
import { loadConfig } from '../backend-node/src/config.js';
import { createPool } from '../backend-node/src/database.js';
import { migrate } from '../backend-node/src/migration.js';
import { Repository } from '../backend-node/src/repository.js';

const require = createRequire(new URL('../backend-node/package.json', import.meta.url));
const { generateKeyPair, exportJWK, SignJWT } = await import(pathToFileURL(require.resolve('jose')).href);
const options = Object.fromEntries(process.argv.slice(2).map(arg => arg.replace(/^--/, '').split('=')));
const samples = Number(options.samples ?? 50);
const warmups = Number(options.warmups ?? 5);
const mode = options.mode ?? 'legacy';
assert.ok(Number.isInteger(samples) && samples > 0 && samples <= 10000);
assert.ok(Number.isInteger(warmups) && warmups >= 0 && warmups <= 1000);
assert.ok(['legacy', 'light'].includes(mode));
const databaseUrl = process.env.TEST_DATABASE_URL;
assert.ok(databaseUrl, 'TEST_DATABASE_URL is required; use a disposable local PostgreSQL instance');
const db = new URL(databaseUrl);
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(db.hostname), 'Only local disposable databases are allowed');
const schema = `capture_bench_${randomUUID().replaceAll('-', '')}`;
const admin = createPool(databaseUrl);
let pool, service, jwks;
const listen = async server => {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return `http://127.0.0.1:${server.address().port}`;
};
const close = async server => {
  if (!server) return;
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
};
const percent = (sorted, p) => sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)];
function summary(raw) {
  const sorted = [...raw].sort((a, b) => a - b);
  return { samples: raw.length, mean_ms: raw.reduce((a, b) => a + b, 0) / raw.length,
    p50_ms: percent(sorted, .5), p95_ms: percent(sorted, .95), min_ms: sorted[0], max_ms: sorted.at(-1), raw_ms: raw };
}
function point(index, repeated) {
  return { kind: 'word', language: 'en', title: repeated ? 'celery' : `benchmark term ${index}`,
    sense_key: 'vegetable', meaning: '名词：芹菜。', context: '芹菜的英文咋说',
    explanation: 'celery 通常作不可数名词；a stalk of celery 表示一根芹菜茎。',
    examples: [{ text: 'Could you buy some celery?', translation: '你能买点芹菜吗？' },
      { text: 'Chop the celery and add it to the soup.', translation: '把芹菜切碎，加到汤里。' }], scenes: ['Food & cooking'] };
}
function payload(index, repeated) {
  const full = point(index, repeated);
  return { request_id: `bench_${index}_${randomUUID().replaceAll('-', '')}`, source: 'automatic',
    items: mode === 'legacy' ? [full] : [{ kind: full.kind, language: full.language, title: full.title, context: full.context }] };
}

try {
  await admin.query(`CREATE SCHEMA ${schema}`);
  pool = createPool(databaseUrl, { options: `-c search_path=${schema}` });
  await migrate(pool);
  const keys = await generateKeyPair('RS256', { extractable: true });
  const publicJwk = { ...await exportJWK(keys.publicKey), kid: 'isolated-benchmark', alg: 'RS256', use: 'sig' };
  jwks = createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ keys: [publicJwk] }));
  });
  const issuer = await listen(jwks) + '/';
  let handler;
  service = createServer((request, response) => handler(request, response));
  const base = await listen(service);
  const config = loadConfig({ DATABASE_URL: databaseUrl, PUBLIC_URL: base, AUTH_ISSUER: issuer,
    AUTH_AUDIENCE: base + '/mcp', AUTH_JWKS_URL: issuer + 'jwks', CLOUD_ALLOW_INSECURE_LOCAL: 'true' });
  const errors = [];
  handler = createApp({ config, repositoryFactory: principal => new Repository(pool, principal),
    readiness: async () => true, logger: { error: code => errors.push(code) } });
  async function authorization(subject) {
    return 'Bearer ' + await new SignJWT({ iss: issuer, sub: subject, aud: config.authAudience,
      exp: Math.floor(Date.now() / 1000) + 3600, scope: 'memory:read memory:write' })
      .setProtectedHeader({ alg: 'RS256', kid: 'isolated-benchmark' }).sign(keys.privateKey);
  }
  async function request(path, auth, body) {
    const response = await fetch(base + path, { method: body === undefined ? 'GET' : 'POST',
      headers: { Authorization: auth, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(path === '/mcp' ? { Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': '2025-03-26' } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body) });
    const result = await response.json();
    assert.equal(response.status, 200, JSON.stringify(result));
    if (path === '/mcp') { assert.ok(!result.error, JSON.stringify(result)); return result.result.structuredContent; }
    return result;
  }
  const metrics = {};
  let serial = 0;
  for (const transport of ['REST', 'MCP']) {
    for (const repeated of [false, true]) {
      const auth = await authorization(`${schema}-${transport}-${repeated}`);
      // Prepare tenant/preferences before measuring; each route still performs its real auth and DB work.
      await request('/v1/settings', auth);
      const timings = [];
      let inputBytes = 0;
      for (let index = -warmups; index < samples; index++) {
        const args = payload(serial++, repeated);
        const body = transport === 'REST' ? args : { jsonrpc: '2.0', id: serial, method: 'tools/call',
          params: { name: mode === 'legacy' ? 'save_points' : 'capture_points', arguments: args } };
        const started = performance.now();
        const result = await request(transport === 'REST' ? (mode === 'legacy' ? '/v1/captures' : '/v1/observations') : '/mcp', auth, body);
        const elapsed = performance.now() - started;
        assert.ok(!result.error, JSON.stringify(result));
        assert.ok(['added', 'merged'].includes(result.results?.[0]?.status), JSON.stringify(result));
        if (mode === 'light') assert.equal(result.results[0].enrichment_state, 'pending', JSON.stringify(result));
        if (index >= 0) { timings.push(elapsed); inputBytes += Buffer.byteLength(JSON.stringify(body)); }
      }
      metrics[`${transport.toLowerCase()}_${repeated ? 'repeat' : 'new'}`] = { ...summary(timings), mean_request_bytes: inputBytes / samples };
    }
  }
  assert.deepEqual(errors, []);
  const codeFiles = ['backend-node/src/repository.js', 'backend-node/src/app.js', 'backend-node/src/mcp.js', 'backend-node/src/schemas.js'];
  const hashes = Object.fromEntries(await Promise.all(codeFiles.map(async name => [name,
    createHash('sha256').update(await readFile(new URL('../' + name, import.meta.url))).digest('hex')])));
  const report = { benchmark: 'isolated-postgresql-loopback-http-capture', measured_at: new Date().toISOString(),
    git_sha: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), code_sha256: hashes,
    mode, node_version: process.version, warmups_per_scenario: warmups,
    includes: ['loopback HTTP', 'RSA JWT validation with cached local JWKS', 'actual repository', 'PostgreSQL commit', 'response parsing'],
    excludes: ['Codex inference', 'tool argument generation', 'internet/cloud latency', 'background enrichment completion'],
    postgres_version: (await admin.query('SHOW server_version')).rows[0].server_version, metrics };
  const output = options.output ?? `docs/benchmarks/capture-${mode}.json`;
  await mkdir(new URL('../docs/benchmarks', import.meta.url), { recursive: true });
  await writeFile(output, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ output, mode, metrics: Object.fromEntries(Object.entries(metrics).map(([name, { raw_ms, ...rest }]) => [name, rest])) }, null, 2));
} finally {
  await close(service);
  await close(jwks);
  await pool?.end();
  await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await admin.end();
}
