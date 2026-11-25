import { parse, ValidationError } from './schemas.js';

export const ACTIVITY_DAYS = 182;
export const ACTIVITY_MAX_BODY = 8192;
export const ACTIVITY_DAILY_CAP = 200;
const DAY_MS = 86_400_000;

function validNow(now) {
  const milliseconds = now instanceof Date ? now.getTime() : NaN;
  if (!Number.isFinite(milliseconds)) throw new ValidationError();
  return milliseconds;
}

/** Calendar dates, rather than 24-hour intervals, keep DST days intact. */
export function activityWindow(query = {}, now = new Date()) {
  validNow(now);
  const { timezone } = parse('activityQuery', query);
  const parts = new Intl.DateTimeFormat('en', { timeZone: timezone,
    year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  const end_date = `${values.year}-${values.month}-${values.day}`;
  const end = Date.parse(`${end_date}T00:00:00Z`);
  const dates = Array.from({ length: ACTIVITY_DAYS }, (_, index) =>
    new Date(end - (ACTIVITY_DAYS - 1 - index) * DAY_MS).toISOString().slice(0, 10));
  return { timezone, start_date: dates[0], end_date, dates };
}

export function activityScore(learning, interaction) {
  return Math.round(70 * Math.min(learning / 5, 1) + 30 * Math.min(interaction / 10, 1));
}

export async function readActivity(client, tenantId, query = {}, now = new Date()) {
  const window = activityWindow(query, now);
  const { rows } = await client.query(`
    SELECT date, sum(learning_count)::integer AS learning_count,
      sum(interaction_count)::integer AS interaction_count
    FROM (
      SELECT (e.occurred_at AT TIME ZONE $2)::date::text AS date,
        count(*)::integer AS learning_count, 0 AS interaction_count
      FROM lm_encounters e JOIN lm_points p ON p.tenant_id=e.tenant_id AND p.id=e.point_id
      WHERE e.tenant_id=$1 AND p.kind IN ('word','expression')
        AND e.occurred_at >= ($3::date::timestamp AT TIME ZONE $2)
        AND e.occurred_at < (($4::date + 1)::timestamp AT TIME ZONE $2)
      GROUP BY 1
      UNION ALL
      SELECT (occurred_at AT TIME ZONE $2)::date::text AS date,
        0 AS learning_count, count(*)::integer AS interaction_count
      FROM lm_activity_events
      WHERE tenant_id=$1 AND occurred_at >= ($3::date::timestamp AT TIME ZONE $2)
        AND occurred_at < (($4::date + 1)::timestamp AT TIME ZONE $2)
      GROUP BY 1
    ) activity GROUP BY date`, [tenantId, window.timezone, window.start_date, window.end_date]);
  const byDate = new Map(rows.map(row => [row.date, row]));
  const days = window.dates.map(date => {
    const row = byDate.get(date);
    const learning_count = Number(row?.learning_count ?? 0), interaction_count = Number(row?.interaction_count ?? 0);
    const score = activityScore(learning_count, interaction_count);
    return { date, learning_count, interaction_count, score, level: score === 0 ? 0 : Math.ceil(score / 25) };
  });
  const totals = days.reduce((sum, day) => ({
    learning_count: sum.learning_count + day.learning_count,
    interaction_count: sum.interaction_count + day.interaction_count,
    active_days: sum.active_days + Number(day.score > 0), score: sum.score + day.score,
  }), { learning_count: 0, interaction_count: 0, active_days: 0, score: 0 });
  return { timezone: window.timezone, start_date: window.start_date, end_date: window.end_date,
    weights: { learning: 0.7, interaction: 0.3 }, targets: { learning: 5, interaction: 10 }, days, totals };
}

/** Caller holds the tenant row lock. UI activity never changes learning history. */
export async function recordActivityEvents(client, tenantId, input, now = new Date()) {
  const events = parse('activityEvents', { events: input }).events;
  const milliseconds = validNow(now);
  const ids = events.map(event => event.event_id);
  const existing = await client.query('SELECT event_id::text FROM lm_activity_events WHERE tenant_id=$1 AND event_id=ANY($2::uuid[])', [tenantId, ids]);
  const seen = new Set(existing.rows.map(row => row.event_id));
  for (const event of events) {
    const occurred = Date.parse(event.occurred_at);
    if (!seen.has(event.event_id) && (!Number.isFinite(occurred) || occurred < milliseconds - 300_000 || occurred > milliseconds + 60_000))
      throw new ValidationError();
  }
  const utcDate = now.toISOString().slice(0, 10);
  let dailyCount = Number((await client.query(`SELECT count(*)::integer AS count FROM lm_activity_events
    WHERE tenant_id=$1 AND received_at >= $2::date::timestamp AT TIME ZONE 'UTC'
      AND received_at < ($2::date + 1)::timestamp AT TIME ZONE 'UTC'`, [tenantId, utcDate])).rows[0].count);
  const result = { status: 'ok', accepted: 0, duplicate: 0, throttled: 0 };
  for (const event of events) {
    if (seen.has(event.event_id)) { result.duplicate++; continue; }
    seen.add(event.event_id);
    if (dailyCount >= ACTIVITY_DAILY_CAP) { result.throttled++; continue; }
    const inserted = await client.query(`INSERT INTO lm_activity_events
      (tenant_id,event_id,kind,occurred_at,received_at,occurred_bucket)
      VALUES($1,$2::uuid,$3,$4::timestamptz,$5::timestamptz,$6) ON CONFLICT DO NOTHING RETURNING event_id`,
    [tenantId, event.event_id, event.kind, event.occurred_at, now.toISOString(), Math.floor(Date.parse(event.occurred_at) / 5000)]);
    if (inserted.rowCount) { result.accepted++; dailyCount++; }
    else result.throttled++;
  }
  return result;
}
