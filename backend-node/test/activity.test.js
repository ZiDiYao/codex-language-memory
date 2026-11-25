import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { activityWindow, activityScore, readActivity, recordActivityEvents } from '../src/activity.js';
import { parse } from '../src/schemas.js';

const now = new Date('2026-11-01T03:30:00Z');
const event = (overrides = {}) => ({ event_id: randomUUID(), kind: 'button', occurred_at: now.toISOString(), ...overrides });
const invalid = error => error.code === 'invalid_request';

test('activity dates follow the requested calendar and always contain 182 consecutive days across DST', () => {
  const local = activityWindow({ timezone: 'America/Toronto' }, now);
  assert.equal(local.end_date, '2026-10-31');
  assert.equal(activityWindow({}, now).end_date, '2026-11-01');
  assert.equal(activityWindow({ timezone: 'Etc/UTC' }, now).timezone, 'UTC');
  for (const instant of [now, new Date('2026-03-09T02:00:00Z'), new Date('2026-11-02T02:00:00Z')]) {
    const { dates } = activityWindow({ timezone: 'America/Toronto' }, instant);
    assert.equal(dates.length, 182); assert.equal(new Set(dates).size, 182);
    for (let index = 1; index < dates.length; index++)
      assert.equal(Date.parse(dates[index]) - Date.parse(dates[index - 1]), 86_400_000);
  }
  for (const timezone of ['not-a-zone', '+05:00', "UTC'); DROP TABLE x; --", '', 'UTC\u0000'])
    assert.throws(() => activityWindow({ timezone }), invalid);
  assert.throws(() => activityWindow({ timezone: 'UTC', user_id: 'other' }), invalid);
});

test('explicit calendar years include leap days and enforce the timezone-local current-year boundary', () => {
  const leap = activityWindow({ year: 2024, timezone: 'America/Toronto' }, now);
  assert.equal(leap.year, 2024); assert.equal(leap.today, '2026-10-31');
  assert.equal(leap.start_date, '2024-01-01'); assert.equal(leap.end_date, '2024-12-31');
  assert.equal(leap.dates.length, 366); assert.equal(leap.dates.filter(date => date === '2024-02-29').length, 1);
  assert.equal(activityWindow({ year: 2025 }, now).dates.length, 365);
  assert.equal(activityWindow({ year: 1970 }, now).dates.length, 365);
  assert.equal(activityWindow({}, now).year, null);
  for (const year of [1969, 2027, 2024.5, '2024', null, NaN, Infinity])
    assert.throws(() => activityWindow({ year }, now), invalid);
  const midnight = new Date('2027-01-01T00:30:00Z');
  assert.throws(() => activityWindow({ year: 2027, timezone: 'America/Toronto' }, midnight), invalid);
  assert.equal(activityWindow({ year: 2027, timezone: 'UTC' }, midnight).dates.length, 365);
  assert.equal(activityWindow({ year: 2027, timezone: 'Pacific/Auckland' }, new Date('2026-12-31T11:30:00Z')).year, 2027);
});

test('year metadata exposes actual evidence years while future dates cannot contribute counts or score', async () => {
  let calls = 0;
  const client = { query: async () => ++calls === 1 ? { rows: [{ first_year: 2024 }] } : { rows: [
    { date: '2026-10-31', learning_count: 1, interaction_count: 1 },
    { date: '2026-11-01', learning_count: 99, interaction_count: 99 },
  ] } };
  const result = await readActivity(client, 'tenant', { timezone: 'America/Toronto', year: 2026 }, now);
  assert.equal(result.days.length, 365); assert.equal(result.today, '2026-10-31');
  assert.deepEqual(result.available_years, [2026, 2025, 2024]);
  assert.deepEqual(result.days.find(day => day.date === '2026-11-01'),
    { date: '2026-11-01', learning_count: 0, interaction_count: 0, score: 0, level: 0 });
  assert.deepEqual(result.totals, { learning_count: 1, interaction_count: 1, score: 17, active_days: 1 });
  const empty = await readActivity({ query: async () => ({ rows: [] }) }, 'empty', { year: 2024 }, now);
  assert.deepEqual(empty.available_years, [2026]); assert.equal(empty.days.length, 366);
  assert.equal(empty.totals.active_days, 0);
});

test('heatmap weight and saturation are explicit and zero dates stay empty', async () => {
  assert.equal(activityScore(0, 0), 0); assert.equal(activityScore(1, 0), 14);
  assert.equal(activityScore(5, 0), 70); assert.equal(activityScore(0, 10), 30);
  assert.equal(activityScore(2, 5), 43); assert.equal(activityScore(500, 500), 100);
  const result = await readActivity({ query: async () => ({ rows: [
    { date: '2026-10-31', learning_count: 3, interaction_count: 5 },
  ] }) }, 'verified-tenant', { timezone: 'America/Toronto' }, now);
  assert.equal(result.days.length, 182);
  assert.equal(result.days[0].score, 0); assert.equal(result.days[0].level, 0);
  assert.deepEqual(result.days.at(-1), { date: '2026-10-31', learning_count: 3, interaction_count: 5, score: 57, level: 3 });
  assert.deepEqual(result.totals, { learning_count: 3, interaction_count: 5, active_days: 1, score: 57 });
  assert.deepEqual(result.weights, { learning: 0.7, interaction: 0.3 });
  assert.deepEqual(result.targets, { learning: 5, interaction: 10 });
});

test('UI event shapes reject identifiers, arbitrary content, invalid dates and oversized batches', () => {
  for (const value of [
    {}, { events: [] }, { events: Array.from({ length: 21 }, () => event()) },
    { events: [event({ kind: 'view' })] }, { events: [event({ event_id: 'not-a-uuid' })] },
    { events: [event({ occurred_at: '2026-02-30T00:00:00Z' })] },
    { events: [event({ occurred_at: '2026-11-01' })] }, { events: [event({ record_id: 1 })] },
    { events: [event({ text: 'private text', url: 'https://example.invalid' })] },
    { events: [event()], tenant_id: 'other' },
  ]) assert.throws(() => parse('activityEvents', value), invalid);
});

test('only new events need a recent timestamp; accepted UUID replays stay idempotent', async () => {
  const old = event({ occurred_at: '2020-01-01T00:00:00Z' });
  const replayClient = { query: async sql => sql.startsWith('SELECT event_id')
    ? { rows: [{ event_id: old.event_id }] } : { rows: [{ count: 0 }] } };
  assert.deepEqual(await recordActivityEvents(replayClient, 'tenant', [old], now),
    { status: 'ok', accepted: 0, duplicate: 1, throttled: 0 });
  for (const occurred_at of ['2026-11-01T03:24:59.999Z', '2026-11-01T03:31:00.001Z']) {
    let inserts = 0;
    const client = { query: async sql => { if (sql.startsWith('INSERT')) inserts++; return { rows: [] }; } };
    await assert.rejects(recordActivityEvents(client, 'tenant', [event({ occurred_at })], now), invalid);
    assert.equal(inserts, 0);
  }
});
