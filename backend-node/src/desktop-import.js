/** One-time, tenant-bound import of a closed desktop learning snapshot. */
import { z } from 'zod';
import { timestamp } from './database.js';
import { encode, fingerprint, normalized } from './parity.js';
import { ALGORITHM } from './learning.js';
import { settingsWithDefaults, validateDatabaseText, ValidationError } from './schemas.js';
import { uniqueScenes } from './scenes.js';

export const MAX_DESKTOP_IMPORT_BODY = 8 * 1024 * 1024;
export const DESKTOP_TABLES = Object.freeze(['knowledge', 'settings', 'capture_preferences', 'encounters', 'review_events',
  'memory_states', 'learner_preferences', 'export_receipts', 'study_sessions', 'study_items', 'study_answers']);
const fail = () => { throw new ValidationError(); };
const rawText = (max, min = 0) => z.string().refine(value => [...value].length >= min && [...value].length <= max);
const nullableText = (max) => rawText(max).nullable();
const id = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const count = z.number().int().min(0).max(2147483647);
const bit = z.union([z.literal(0), z.literal(1)]);
const language = rawText(35, 2).regex(/^[a-zA-Z]{2,8}(?:-[a-zA-Z0-9]{1,8})*$/u);
const result = z.enum(['correct', 'partial', 'incorrect', 'skipped']);
const hash = z.string().regex(/^[a-f0-9]{64}$/u);
const instant = rawText(40, 20).refine(value => {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/u);
  if (!match || !Number.isFinite(Date.parse(value))) return false;
  const [, year, month, day] = match;
  return Number(month) >= 1 && Number(month) <= 12 && Number(day) >= 1
    && Number(day) <= new Date(Date.UTC(Number(year), Number(month), 0)).getUTCDate();
});
const jsonColumn = nullableText(MAX_DESKTOP_IMPORT_BODY);
const pointSchema = z.object({
  id, kind: z.enum(['word', 'expression', 'grammar', 'correction']), language,
  title: rawText(350, 1), title_key: rawText(2000), sense_key: rawText(1000), meaning: rawText(2000),
  context: nullableText(2000), corrected_sentence: nullableText(2000), explanation: nullableText(2000), examples: jsonColumn,
  created_at: instant, last_seen_at: instant, encounter_count: count, status: z.enum(['new', 'mastered']),
  last_reviewed_at: instant.nullable(), last_review_result: result.nullable(),
  note: nullableText(30000).optional().default(null), scenes: jsonColumn.optional().default('[]'),
  scenes_custom: bit.optional().default(0), additional_senses: jsonColumn.optional().default('[]'),
  repeat_priority: count.optional().default(0),
}).strict();
const encounterSchema = z.object({ id, record_id: id, request_id: rawText(1000, 1), occurred_at: instant,
  context: nullableText(2000), source: z.enum(['automatic', 'explicit']) }).strict();
const reviewSchema = z.object({ id, record_id: id, occurred_at: instant, result, assisted: bit,
  effort: z.enum(['standard', 'hard', 'easy']), prompt: nullableText(2000), answer: nullableText(2000),
  rating: z.number().int().min(1).max(4).nullable(), predicted_recall: z.number().finite().min(0).max(1).nullable(),
  fsrs_log: jsonColumn, algorithm: jsonColumn }).strict();
const memorySchema = z.object({ record_id: id, card: rawText(100000, 2), due_at: instant,
  rated_reviews: count, algorithm: rawText(100000, 2) }).strict();
const rows = schema => z.array(schema).max(50000);
const tablesSchema = z.object({
  knowledge: rows(pointSchema), settings: z.array(z.object({ id: z.literal(1), recording: bit }).strict()).max(1),
  capture_preferences: z.array(z.object({ id: z.literal(1), data: rawText(100000, 2) }).strict()).max(1),
  encounters: rows(encounterSchema), review_events: rows(reviewSchema), memory_states: rows(memorySchema),
  learner_preferences: rows(z.object({ language: z.union([z.literal('*'), language]), data: rawText(100000, 2), updated_at: instant }).strict()),
  export_receipts: rows(z.object({ scope: rawText(100000, 1), data: rawText(100000, 2) }).strict()),
  study_sessions: rows(z.object({ id: rawText(1000, 1), options: rawText(100000, 2), state: z.enum(['active', 'paused', 'completed']),
    version: count, created_at: instant, updated_at: instant }).strict()),
  study_items: rows(z.object({ session_id: rawText(1000, 1), ordinal: count, record_id: id, reason: rawText(1000, 1),
    prompt: nullableText(2000), source_revision: hash.nullable(), assisted: bit, review_event_id: id.nullable() }).strict()),
  study_answers: rows(z.object({ request_id: rawText(1000, 1), fingerprint: hash, session_id: rawText(1000, 1), applied_version: count }).strict()),
}).strict();
const envelope = z.object({ schema_version: z.literal(1),
  source_id: z.string().regex(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u), tables: tablesSchema }).strict();
const exampleSchema = z.object({ text: rawText(2000, 1), translation: nullableText(2000).optional() }).strict();
const senseSchema = z.object({ sense_key: rawText(1000), meaning: nullableText(2000), explanation: nullableText(2000),
  context: nullableText(2000), corrected_sentence: nullableText(2000), examples: z.array(exampleSchema).max(5).nullable() }).strict();
const cardSchema = z.object({ card_id: id, state: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  step: count.nullable().optional(), stability: z.number().finite().positive().nullable(),
  difficulty: z.number().finite().min(1).max(10).nullable(), due: instant, last_review: instant.nullable() }).strict()
  .refine(card => card.state === 1 || (card.stability !== null && card.difficulty !== null));

function safeTree(value, forbidCredentials = false) {
  const pending = [[value, 0]]; let nodes = 0;
  while (pending.length) {
    const [item, depth] = pending.pop();
    if (++nodes > 500000 || depth > 40) fail();
    if (item === null || typeof item === 'boolean') continue;
    if (typeof item === 'string') { validateDatabaseText(item); continue; }
    if (typeof item === 'number') { if (!Number.isFinite(item)) fail(); continue; }
    if (!item || typeof item !== 'object') fail();
    for (const [key, child] of Object.entries(item)) {
      validateDatabaseText(key);
      if (forbidCredentials && /^(?:access_token|refresh_token|client_secret|password|credentials|private_key|code_verifier)$/iu.test(key)) fail();
      pending.push([child, depth + 1]);
    }
  }
}
function decoded(value, fallback) {
  if (value == null) return fallback;
  let result;
  try { result = JSON.parse(value); } catch { fail(); }
  safeTree(result, true);
  return result;
}
function objectColumn(value) {
  const result = decoded(value, null);
  if (!result || Array.isArray(result) || typeof result !== 'object') fail();
  return result;
}
function unique(items, key) {
  const values = items.map(key);
  if (new Set(values).size !== values.length) fail();
}

export function validateDesktopSnapshot(raw) {
  try {
    safeTree(raw);
    if (Buffer.byteLength(JSON.stringify(raw)) > MAX_DESKTOP_IMPORT_BODY) fail();
    const value = envelope.parse(raw), tables = value.tables;
    const points = new Set(tables.knowledge.map(row => row.id)), events = new Map(tables.review_events.map(row => [row.id, row]));
    const sessions = new Set(tables.study_sessions.map(row => row.id));
    for (const name of ['knowledge', 'encounters', 'review_events', 'study_sessions']) unique(tables[name], row => row.id);
    unique(tables.memory_states, row => row.record_id); unique(tables.learner_preferences, row => row.language);
    unique(tables.export_receipts, row => row.scope); unique(tables.study_answers, row => row.request_id);
    unique(tables.encounters, row => encode([row.record_id, row.request_id]));
    unique(tables.study_items, row => encode([row.session_id, row.ordinal]));
    for (const name of ['encounters', 'review_events', 'memory_states', 'study_items'])
      for (const row of tables[name]) if (!points.has(row.record_id)) fail();
    for (const row of tables.study_items) {
      if (!sessions.has(row.session_id) || (row.review_event_id != null
          && events.get(row.review_event_id)?.record_id !== row.record_id)) fail();
    }
    for (const row of tables.study_answers) if (!sessions.has(row.session_id)) fail();
    for (const point of tables.knowledge) {
      if (point.title_key !== normalized(point.title)) fail();
      point.examples = z.array(exampleSchema).max(5).parse(decoded(point.examples, []));
      point.additional_senses = z.array(senseSchema).max(1000).parse(decoded(point.additional_senses, []));
      const labels = decoded(point.scenes, []);
      if (!Array.isArray(labels) || labels.length > 12 || labels.some(label => typeof label !== 'string'
          || !label.trim() || [...label].length > 80 || /[,;]/u.test(label))) fail();
      point.scenes = uniqueScenes(labels);
      if (point.scenes.some(label => [...label].length > 80 || /[,;]/u.test(label))) fail();
      if (point.last_seen_at < point.created_at && Date.parse(point.last_seen_at) < Date.parse(point.created_at)) fail();
    }
    for (const row of tables.review_events) {
      row.algorithm = row.algorithm == null ? null : objectColumn(row.algorithm);
      row.fsrs_log = row.fsrs_log == null ? null : objectColumn(row.fsrs_log);
      if (row.fsrs_log?.review_datetime != null) instant.parse(row.fsrs_log.review_datetime);
      if (row.fsrs_log?.card_id != null) id.parse(row.fsrs_log.card_id);
    }
    for (const row of tables.memory_states) {
      row.algorithm = objectColumn(row.algorithm);
      row.card = objectColumn(row.card);
    }
    for (const name of ['capture_preferences', 'learner_preferences', 'export_receipts'])
      for (const row of tables[name]) row.data = objectColumn(row.data);
    for (const row of tables.study_sessions) row.options = objectColumn(row.options);
    const global = tables.learner_preferences.find(row => row.language === '*')?.data ?? {};
    const settings = settingsWithDefaults({ ...(tables.capture_preferences[0]?.data ?? {}),
      enabled: (tables.settings[0]?.recording ?? 1) === 1, first_language: global.first_language ?? null,
      explanation_language: global.explanation_language ?? null });
    return { payload: raw, sourceId: value.source_id, payloadSha: fingerprint(raw), tables, settings };
  } catch { throw new ValidationError(); }
}

function remapLog(log, pointId) {
  if (log == null) return null;
  const result = { ...log };
  if (Object.hasOwn(result, 'card_id')) result.card_id = pointId;
  if (typeof result.review_datetime === 'string') result.review_datetime = timestamp(result.review_datetime);
  return result;
}
function reviewKey(row, pointId) {
  let log = row.fsrs_log;
  if (typeof log === 'string') { try { log = JSON.parse(log); } catch { log = { legacy_log: log }; } }
  return fingerprint({ occurred_at: timestamp(row.occurred_at), result: row.result, assisted: Boolean(row.assisted),
    effort: row.effort, prompt: row.prompt, answer: row.answer, rating: row.rating, predicted_recall: row.predicted_recall,
    fsrs_log: remapLog(log, pointId), algorithm: row.algorithm });
}

export async function importDesktopSnapshot(repository, raw) {
  const snapshot = validateDesktopSnapshot(raw), { sourceId, payloadSha, tables } = snapshot;
  return repository.transaction(true, async (client, tenant) => {
    const previous = (await client.query('SELECT payload_sha,result FROM lm_desktop_imports WHERE tenant_id=$1 AND source_id=$2',
      [repository.tenantId, sourceId])).rows[0];
    if (previous) return previous.payload_sha === payloadSha
      ? { ...previous.result, status: 'already_imported' }
      : { status: 'failed', error: 'import_source_conflict', source_id: sourceId };
    const hadPoints = Number((await client.query('SELECT count(*) FROM lm_points WHERE tenant_id=$1', [repository.tenantId])).rows[0].count) > 0;
    const counts = { points_total: tables.knowledge.length, points_inserted: 0, points_existing: 0, encounters_inserted: 0,
      encounters_deduplicated: 0, reviews_inserted: 0, reviews_deduplicated: 0, memory_states_inserted: 0,
      memory_states_archived: 0, settings_imported: 0, archived_rows: DESKTOP_TABLES.reduce((n, name) => n + tables[name].length, 0) };
    const pointIds = {}, encounterIds = {}, reviewIds = {}, conflicts = [];
    const existing = new Map(), newPoints = new Set(), addedEncounters = new Map();
    for (const point of tables.knowledge) {
      const identity = repository.identity(point.kind, point.language.toLowerCase(), point.title, point.sense_key);
      let live = (await client.query('SELECT * FROM lm_points WHERE tenant_id=$1 AND identity_key=$2', [repository.tenantId, identity])).rows[0];
      if (live) {
        counts.points_existing++;
        conflicts.push({ local_id: point.id, cloud_id: live.id, kind: 'cloud_point_preserved' });
        existing.set(point.id, live);
      } else {
        const incoming = { ...point, identity_key: identity, language: point.language.toLowerCase(), scenes_custom: Boolean(point.scenes_custom),
          created_at: timestamp(point.created_at), last_seen_at: timestamp(point.last_seen_at), last_reviewed_at: timestamp(point.last_reviewed_at) };
        incoming.search_text = repository.searchText(incoming);
        live = await repository.persistPoint(client, incoming, true);
        await repository.setScenes(client, live.id, point.scenes);
        newPoints.add(live.id); counts.points_inserted++;
      }
      pointIds[point.id] = live.id;
    }
    for (const row of tables.encounters) {
      const pointId = pointIds[row.record_id];
      const requestId = /^[a-zA-Z0-9_-]{8,100}$/u.test(row.request_id) ? row.request_id : 'import_' + fingerprint([sourceId, row.request_id]);
      const prior = (await client.query('SELECT * FROM lm_encounters WHERE tenant_id=$1 AND point_id=$2 AND request_id=$3',
        [repository.tenantId, pointId, requestId])).rows[0];
      if (prior) {
        // One capture request is one encounter even when legacy sense rows
        // carried different contexts. The full incoming row remains archived.
        if (timestamp(prior.occurred_at) !== timestamp(row.occurred_at) || prior.context !== row.context || prior.source !== row.source)
          conflicts.push({ local_id: row.record_id, cloud_id: pointId, kind: 'encounter_metadata_archived' });
        counts.encounters_deduplicated++; encounterIds[row.id] = prior.id; continue;
      }
      const inserted = (await client.query(`INSERT INTO lm_encounters(tenant_id,point_id,request_id,occurred_at,context,source)
        VALUES($1,$2,$3,$4,$5,$6) RETURNING id`, [repository.tenantId, pointId, requestId, row.occurred_at, row.context, row.source])).rows[0];
      encounterIds[row.id] = inserted.id; counts.encounters_inserted++;
      addedEncounters.set(pointId, (addedEncounters.get(pointId) ?? 0) + 1);
    }
    for (const row of tables.review_events) {
      const pointId = pointIds[row.record_id], key = reviewKey(row, pointId);
      const candidates = (await client.query('SELECT * FROM lm_review_events WHERE tenant_id=$1 AND point_id=$2 AND occurred_at=$3',
        [repository.tenantId, pointId, row.occurred_at])).rows;
      const prior = candidates.find(candidate => reviewKey(candidate, pointId) === key);
      if (prior) { reviewIds[row.id] = prior.id; counts.reviews_deduplicated++; continue; }
      const log = remapLog(row.fsrs_log, pointId);
      const inserted = (await client.query(`INSERT INTO lm_review_events(tenant_id,point_id,occurred_at,result,assisted,effort,
        prompt,answer,rating,predicted_recall,fsrs_log,algorithm) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb) RETURNING id`,
      [repository.tenantId, pointId, row.occurred_at, row.result, Boolean(row.assisted), row.effort, row.prompt, row.answer,
        row.rating, row.predicted_recall, log == null ? null : encode(log), row.algorithm == null ? null : encode(row.algorithm)])).rows[0];
      reviewIds[row.id] = inserted.id; counts.reviews_inserted++;
    }
    for (const row of tables.memory_states) {
      const pointId = pointIds[row.record_id];
      const prior = (await client.query('SELECT point_id FROM lm_memory_states WHERE tenant_id=$1 AND point_id=$2', [repository.tenantId, pointId])).rows[0];
      const card = cardSchema.safeParse(row.card);
      if (prior || !card.success || row.card.card_id !== row.record_id || fingerprint(row.algorithm) !== fingerprint(ALGORITHM)
          || timestamp(row.card.due) !== timestamp(row.due_at)) {
        counts.memory_states_archived++;
        conflicts.push({ local_id: row.record_id, cloud_id: pointId, kind: prior ? 'cloud_memory_preserved' : 'unsupported_memory_archived' });
        continue;
      }
      await client.query(`INSERT INTO lm_memory_states(tenant_id,point_id,card,due_at,rated_reviews,algorithm) VALUES($1,$2,$3,$4,$5,$6::jsonb)`,
        [repository.tenantId, pointId, encode({ ...card.data, card_id: pointId }), row.due_at, row.rated_reviews, encode(row.algorithm)]);
      counts.memory_states_inserted++;
    }
    for (const point of tables.knowledge) if (existing.has(point.id)) {
      const live = await repository.point(client, pointIds[point.id]);
      const historyCount = Number((await client.query('SELECT count(*) FROM lm_encounters WHERE tenant_id=$1 AND point_id=$2',
        [repository.tenantId, live.id])).rows[0].count);
      live.encounter_count = Math.max(live.encounter_count + (newPoints.has(live.id) ? 0 : addedEncounters.get(live.id) ?? 0),
        point.encounter_count, historyCount);
      if (live.encounter_count > 2147483647) fail();
      live.repeat_priority = Math.max(live.repeat_priority, point.repeat_priority);
      if (timestamp(point.created_at) < timestamp(live.created_at)) live.created_at = point.created_at;
      if (timestamp(point.last_seen_at) > timestamp(live.last_seen_at)) live.last_seen_at = point.last_seen_at;
      if (point.last_reviewed_at && (!live.last_reviewed_at || timestamp(point.last_reviewed_at) > timestamp(live.last_reviewed_at))) {
        live.last_reviewed_at = point.last_reviewed_at; live.last_review_result = point.last_review_result;
      }
      await repository.persistPoint(client, live);
      addedEncounters.delete(live.id);
    }
    const currentSettings = settingsWithDefaults(tenant.settings);
    const settingsImported = !hadPoints && fingerprint(currentSettings) === fingerprint(settingsWithDefaults({}));
    if (settingsImported) {
      await client.query('UPDATE lm_tenants SET settings=$2::jsonb,preferences_version=preferences_version+1 WHERE id=$1',
        [repository.tenantId, encode(snapshot.settings)]);
      counts.settings_imported = 1;
    }
    await client.query('UPDATE lm_tenants SET content_version=content_version+1 WHERE id=$1', [repository.tenantId]);
    const response = { status: 'imported', source_id: sourceId, payload_sha: payloadSha, counts, conflicts,
      point_id_map: pointIds, encounter_id_map: encounterIds, review_id_map: reviewIds };
    await client.query(`INSERT INTO lm_desktop_imports(tenant_id,source_id,payload_sha,schema_version,snapshot,result)
      VALUES($1,$2,$3,1,$4::jsonb,$5::jsonb)`, [repository.tenantId, sourceId, payloadSha, JSON.stringify(snapshot.payload), JSON.stringify(response)]);
    return response;
  });
}
