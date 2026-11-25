import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createPool, checkSchema, NODE_SCHEMA_REVISION } from '../src/database.js';
import { migrate } from '../src/migration.js';
import { Repository } from '../src/repository.js';
import { readActivity, recordActivityEvents } from '../src/activity.js';

const dbtest = (name, operation) => test(name, { skip: !process.env.TEST_DATABASE_URL }, operation);
const principal = subject => ({ issuer: 'https://activity-fixture.example/', subject });
async function fixture(t, { migrateNow = true } = {}) {
  const admin = createPool(process.env.TEST_DATABASE_URL);
  const schema = 'activity_' + randomUUID().replaceAll('-', '');
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = createPool(process.env.TEST_DATABASE_URL, { options: `-c search_path=${schema}` });
  t.after(async () => { await pool.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); });
  if (migrateNow) await migrate(pool);
  return { pool, schema, repo: subject => new Repository(pool, principal(subject)) };
}
async function capture(pool, repo, request, title, kind, occurred) {
  const result = await repo.observe(request, [{ kind, title, language: 'en' }]);
  assert.equal(['added', 'merged'].includes(result.results[0].status), true);
  await pool.query('UPDATE lm_encounters SET occurred_at=$4 WHERE tenant_id=$1 AND point_id=$2 AND request_id=$3',
    [repo.tenantId, result.results[0].id, request, occurred]);
  return result.results[0].id;
}
const event = (occurred_at, kind = 'button', event_id = randomUUID()) => ({ event_id, kind, occurred_at });
const record = (repo, events, now) => repo.transaction(true, client => recordActivityEvents(client, repo.tenantId, events, now));
const read = (repo, timezone, now) => repo.transaction(false, client => readActivity(client, repo.tenantId, { timezone }, now));

dbtest('0003 upgrades additively to activity0004 and concurrent migrators preserve encounter evidence', async t => {
  const { pool, repo } = await fixture(t, { migrateNow: false });
  for (const filename of ['0001_remote_storage.sql', '0002_desktop_imports.sql', '0003_lightweight_capture.sql'])
    await pool.query(await readFile(new URL('../migrations/' + filename, import.meta.url), 'utf8'));
  const learner = repo('before-upgrade');
  await capture(pool, learner, 'before-upgrade-encounter', 'rinse', 'word', '2026-11-01T12:00:00Z');
  assert.equal(await checkSchema(pool), false);
  const outcomes = await Promise.all([migrate(pool), migrate(pool)]);
  assert.deepEqual(outcomes.map(value => value.status).sort(), ['current', 'migrated']);
  assert.equal((await pool.query('SELECT revision FROM lm_node_migrations')).rows[0].revision, NODE_SCHEMA_REVISION);
  assert.equal(await checkSchema(pool), true);
  assert.equal((await pool.query('SELECT version_num FROM alembic_version')).rows[0].version_num, '0001_remote_storage');
  assert.equal((await pool.query('SELECT count(*)::integer n FROM lm_encounters')).rows[0].n, 1);
  assert.equal((await pool.query('SELECT count(*)::integer n FROM lm_activity_events')).rows[0].n, 0);
  const data = await read(learner, 'UTC', new Date('2026-11-02T12:00:00Z'));
  assert.equal(data.totals.learning_count, 1); assert.equal(data.totals.interaction_count, 0);
  await pool.query("UPDATE lm_node_migrations SET revision='unknown_future'");
  await assert.rejects(migrate(pool), /Unsupported Node extension/);
  assert.equal((await pool.query('SELECT count(*)::integer n FROM lm_encounters')).rows[0].n, 1);
});

dbtest('activity buckets use tenant-local calendar dates across DST and count only actual word/expression encounters', async t => {
  const { pool, repo } = await fixture(t);
  const alice = repo('alice'), bob = repo('bob');
  await capture(pool, alice, 'word-before-midnight', 'rinse', 'word', '2026-11-01T03:30:00Z');
  await capture(pool, alice, 'word-repeated-hour', 'rinse', 'word', '2026-11-01T06:30:00Z');
  await capture(pool, alice, 'expression-first-hour', 'hold a grudge', 'expression', '2026-11-01T05:30:00Z');
  await capture(pool, alice, 'grammar-not-weighted', 'past perfect', 'grammar', '2026-11-01T06:30:00Z');
  await capture(pool, alice, 'correction-not-weighted', 'corrected sentence', 'correction', '2026-11-01T06:30:00Z');
  await capture(pool, alice, 'outside-activity-window', 'historic', 'word', '2020-01-01T12:00:00Z');
  await capture(pool, bob, 'other-tenant-encounter', 'personal', 'word', '2026-11-01T06:30:00Z');
  const uiNow = new Date('2026-11-01T03:31:00Z');
  await record(alice, [event(uiNow.toISOString())], uiNow);
  const now = new Date('2026-11-02T12:00:00Z');
  const local = await read(alice, 'America/Toronto', now);
  assert.equal(local.days.length, 182); assert.equal(local.end_date, '2026-11-02');
  assert.deepEqual(local.days.find(day => day.date === '2026-10-31'),
    { date: '2026-10-31', learning_count: 1, interaction_count: 1, score: 17, level: 1 });
  assert.deepEqual(local.days.find(day => day.date === '2026-11-01'),
    { date: '2026-11-01', learning_count: 2, interaction_count: 0, score: 28, level: 2 });
  assert.deepEqual(local.totals, { learning_count: 3, interaction_count: 1, active_days: 2, score: 45 });
  assert.equal(local.days.filter(day => day.score === 0).length, 180);
  const utc = await read(alice, 'UTC', now);
  assert.deepEqual(utc.days.find(day => day.date === '2026-11-01'),
    { date: '2026-11-01', learning_count: 3, interaction_count: 1, score: 45, level: 2 });
  const other = await read(bob, 'UTC', now);
  assert.equal(other.totals.learning_count, 1); assert.equal(other.totals.interaction_count, 0);
  assert.equal((await pool.query('SELECT count(*)::integer n FROM lm_encounters WHERE tenant_id=$1', [alice.tenantId])).rows[0].n, 6,
    'UI clicks and heatmap reads never insert learning encounters');
});

dbtest('batched clicks retain the same five-second buckets as individual requests and accepted UUID retries deduplicate', async t => {
  const { pool, repo } = await fixture(t);
  const alice = repo('batched'), bob = repo('individual');
  const now = new Date('2026-11-24T12:00:20Z');
  const first = event('2026-11-24T12:00:00Z');
  const second = event('2026-11-24T12:00:06Z');
  const rapid = event('2026-11-24T12:00:06.500Z');
  assert.deepEqual(await record(alice, [first, second, rapid], now), { status: 'ok', accepted: 2, duplicate: 0, throttled: 1 });
  const outcomes = await Promise.all([record(bob, [first], now), record(bob, [second], now), record(bob, [rapid], now)]);
  assert.equal(outcomes.reduce((sum, value) => sum + value.accepted, 0), 2);
  assert.equal(outcomes.reduce((sum, value) => sum + value.throttled, 0), 1);
  assert.deepEqual(await record(alice, [first, second], new Date('2026-11-24T13:00:00Z')),
    { status: 'ok', accepted: 0, duplicate: 2, throttled: 0 });
  assert.equal((await record(alice, [event(second.occurred_at, 'pronunciation')], now)).accepted, 1,
    'button and pronunciation retain independent buckets');
  const concurrent = event('2026-11-24T12:00:15Z');
  const results = await Promise.all([record(alice, [concurrent], now), record(repo('batched'), [concurrent], now)]);
  assert.equal(results.reduce((sum, value) => sum + value.accepted, 0), 1);
  assert.equal(results.reduce((sum, value) => sum + value.duplicate, 0), 1);
  const before = Number((await pool.query('SELECT count(*)::integer n FROM lm_activity_events WHERE tenant_id=$1', [alice.tenantId])).rows[0].n);
  await assert.rejects(record(alice, [event('2026-11-24T11:55:19Z')], now), { code: 'invalid_request' });
  await assert.rejects(record(alice, [event('2026-11-24T12:01:21Z')], now), { code: 'invalid_request' });
  assert.equal((await pool.query('SELECT count(*)::integer n FROM lm_activity_events WHERE tenant_id=$1', [alice.tenantId])).rows[0].n, before);
});

dbtest('UTC-day cap bounds persisted UI activity without modifying records or retaining arbitrary client metadata', async t => {
  const { pool, repo } = await fixture(t);
  const learner = repo('capped'); await learner.settings();
  const now = new Date('2026-11-24T12:00:20Z');
  await pool.query(`INSERT INTO lm_activity_events(tenant_id,event_id,kind,occurred_at,received_at,occurred_bucket)
    SELECT $1, ('00000000-0000-4000-8000-' || lpad(n::text,12,'0'))::uuid, 'button', $2::timestamptz, $2::timestamptz, n
    FROM generate_series(1,200) n`, [learner.tenantId, now.toISOString()]);
  assert.deepEqual(await record(learner, [event(now.toISOString(), 'pronunciation')], now),
    { status: 'ok', accepted: 0, duplicate: 0, throttled: 1 });
  assert.equal((await pool.query('SELECT count(*)::integer n FROM lm_activity_events')).rows[0].n, 200);
  assert.equal((await pool.query('SELECT count(*)::integer n FROM lm_points')).rows[0].n, 0);
  const columns = (await pool.query(`SELECT column_name FROM information_schema.columns
    WHERE table_schema=current_schema() AND table_name='lm_activity_events'`)).rows.map(row => row.column_name);
  assert.deepEqual(columns.sort(), ['tenant_id','event_id','kind','occurred_at','received_at','occurred_bucket'].sort());
});
