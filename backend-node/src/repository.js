import { timestamp } from './database.js';
import { encode, fingerprint, fingerprintAscii, normalized, serializeRecord, mergeSense } from './parity.js';
import { uniqueScenes, inferScenes } from './scenes.js';
import { validatePoint, validatePatch, validateReview, settingsWithDefaults,
  validateSettingsPatch, validateRequestId, validateDatabaseText, ValidationError } from './schemas.js';
import { ALGORITHM, advance, memorySnapshot, recallRating } from './learning.js';

const json = (value) => JSON.stringify(value);
const now = () => timestamp(new Date());
const clone = (value) => structuredClone(value);
const limitValue = (value) => {
  if (!Number.isInteger(value) || value < 1 || value > 50) throw new ValidationError();
  return value;
};
const idValue = (value) => {
  if (!Number.isSafeInteger(value) || value < 1) throw new ValidationError();
  return value;
};
const pointColumns = ['identity_key', 'kind', 'language', 'title', 'title_key', 'sense_key',
  'meaning', 'context', 'corrected_sentence', 'explanation', 'examples', 'additional_senses',
  'note', 'search_text', 'scenes_custom', 'created_at', 'last_seen_at', 'encounter_count',
  'repeat_priority', 'status', 'last_reviewed_at', 'last_review_result'];
const jsonColumns = new Set(['examples', 'additional_senses']);
const compactExamples = (examples) => examples.map((example) => Object.fromEntries(
  Object.entries(example).filter(([, value]) => value != null)));

export function tenantIdentity(principal) {
  if (!principal || typeof principal.issuer !== 'string' || !principal.issuer
    || typeof principal.subject !== 'string' || !principal.subject) {
    throw new ValidationError();
  }
  validateDatabaseText([principal.issuer, principal.subject]);
  return fingerprint([principal.issuer, principal.subject]);
}

export class Repository {
  constructor(pool, principal) {
    this.pool = pool;
    this.tenantId = tenantIdentity(principal);
    this.tenant_id = this.tenantId;
    this.issuer = principal.issuer;
    this.subject = principal.subject;
  }

  async transaction(write, operation) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      let result = await client.query('SELECT * FROM lm_tenants WHERE id=$1', [this.tenantId]);
      if (!result.rowCount) {
        await client.query(`INSERT INTO lm_tenants
          (id,issuer,subject,settings,content_version,preferences_version)
          VALUES ($1,$2,$3,'{}'::jsonb,0,0) ON CONFLICT(id) DO NOTHING`,
        [this.tenantId, this.issuer, this.subject]);
      }
      if (write || !result.rowCount) {
        result = await client.query(`SELECT * FROM lm_tenants WHERE id=$1${write ? ' FOR UPDATE' : ''}`, [this.tenantId]);
      }
      const value = await operation(client, result.rows[0]);
      await client.query('COMMIT');
      return value;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async ping() {
    await this.pool.query('SELECT 1');
    return { status: 'ok' };
  }

  async settings(patch = null) {
    const changes = patch == null ? null : validateSettingsPatch(patch);
    return this.transaction(changes != null, async (client, tenant) => {
      const current = settingsWithDefaults(tenant.settings);
      if (changes == null) return current;
      const updated = settingsWithDefaults({ ...current, ...changes });
      await client.query('UPDATE lm_tenants SET settings=$2::jsonb, preferences_version=preferences_version+1 WHERE id=$1',
        [this.tenantId, json(updated)]);
      return updated;
    });
  }

  async recording(enabled = null) {
    return { enabled: (await this.settings(enabled == null ? null : { enabled })).enabled };
  }

  async versions() {
    return this.transaction(false, async (_, tenant) => ({
      content: tenant.content_version, preferences: tenant.preferences_version,
    }));
  }

  async point(client, id) {
    return (await client.query('SELECT * FROM lm_points WHERE tenant_id=$1 AND id=$2', [this.tenantId, id])).rows[0] ?? null;
  }

  async labels(client, id) {
    const result = await client.query(`SELECT s.name FROM lm_scenes s JOIN lm_point_scenes ps
      ON s.tenant_id=ps.tenant_id AND s.key=ps.scene_key
      WHERE s.tenant_id=$1 AND ps.tenant_id=$1 AND ps.point_id=$2 ORDER BY ps.position,s.key`, [this.tenantId, id]);
    return result.rows.map((row) => row.name);
  }

  async setScenes(client, id, labels) {
    await client.query('DELETE FROM lm_point_scenes WHERE tenant_id=$1 AND point_id=$2', [this.tenantId, id]);
    let position = 0;
    for (const name of uniqueScenes(labels)) {
      const key = normalized(name);
      await client.query('INSERT INTO lm_scenes(tenant_id,key,name) VALUES($1,$2,$3) ON CONFLICT(tenant_id,key) DO NOTHING',
        [this.tenantId, key, name]);
      await client.query('INSERT INTO lm_point_scenes(tenant_id,point_id,scene_key,position) VALUES($1,$2,$3,$4)',
        [this.tenantId, id, key, position++]);
    }
  }

  identity(kind, language, title, senseKey) {
    return fingerprint([kind, language, normalized(title), kind === 'word' ? '' : normalized(senseKey)]);
  }

  async record(client, point) {
    return serializeRecord({ ...point, scenes: await this.labels(client, point.id),
      created_at: timestamp(point.created_at), last_seen_at: timestamp(point.last_seen_at),
      last_reviewed_at: timestamp(point.last_reviewed_at) });
  }

  searchText(point) {
    return normalized([...['title', 'sense_key', 'meaning', 'context', 'corrected_sentence', 'explanation', 'note']
      .map((key) => point[key] ?? ''), encode(point.examples), encode(point.additional_senses)].join('\n'));
  }

  async persistPoint(client, point, insert = false) {
    const values = [this.tenantId, ...pointColumns.map((key) => jsonColumns.has(key) ? json(point[key]) : point[key])];
    const slots = pointColumns.map((key, index) => `$${index + 2}${jsonColumns.has(key) ? '::jsonb' : ''}`);
    const statement = insert
      ? `INSERT INTO lm_points(tenant_id,${pointColumns.join(',')}) VALUES($1,${slots.join(',')}) RETURNING *`
      : `UPDATE lm_points SET ${pointColumns.map((key, index) => `${key}=${slots[index]}`).join(',')}
          WHERE tenant_id=$1 AND id=$${values.length + 1} RETURNING *`;
    if (!insert) values.push(point.id);
    return (await client.query(statement, values)).rows[0];
  }

  async save(requestId, items, source = 'automatic') {
    validateRequestId(requestId);
    if (!['automatic', 'explicit'].includes(source)) throw new ValidationError();
    if (!Array.isArray(items) || items.length < 1 || items.length > 20) throw new ValidationError();
    const digest = fingerprintAscii(source === 'automatic' ? items : { source, items });
    return this.transaction(true, async (client, tenant) => {
      const receipt = (await client.query('SELECT * FROM lm_save_requests WHERE tenant_id=$1 AND request_id=$2',
        [this.tenantId, requestId])).rows[0];
      if (receipt) {
        if (receipt.fingerprint !== digest) return { status: 'failed', error: 'request_id_conflict' };
        const results = clone(receipt.results);
        for (const result of results) if (result.id && !await this.point(client, result.id)) result.deleted = true;
        return { status: 'processed', replayed: true, results };
      }
      const settings = settingsWithDefaults(tenant.settings);
      if (!settings.enabled) return { status: 'paused', results: [] };
      const occurredAt = now();
      const seen = new Set();
      const results = [];
      for (const [index, item] of items.entries()) {
        let incoming;
        try {
          validateDatabaseText(item);
          incoming = validatePoint(item);
        } catch (error) {
          const issues = error.issues ?? error.errors;
          results.push({ index, status: 'failed', errors: Array.isArray(issues) ? issues.map((issue) => ({
            field: (issue.path ?? issue.loc ?? ['content']).join('.'), message: issue.message ?? 'Invalid knowledge point',
          })) : [{ field: 'content', message: 'Invalid knowledge point' }] });
          continue;
        }
        if (!settings.enabled_types.includes(incoming.kind)) {
          results.push({ index, status: 'skipped', reason: 'type_disabled' });
          continue;
        }
        const encounterKey = encode([incoming.kind, incoming.language, normalized(incoming.title), normalized(incoming.sense_key)]);
        if (seen.has(encounterKey)) {
          results.push({ index, status: 'failed', error: 'duplicate_in_batch' });
          continue;
        }
        seen.add(encounterKey);
        const key = this.identity(incoming.kind, incoming.language, incoming.title, incoming.sense_key);
        let point = (await client.query('SELECT * FROM lm_points WHERE tenant_id=$1 AND identity_key=$2', [this.tenantId, key])).rows[0];
        let action;
        if (!point) {
          point = { ...incoming, identity_key: key, title_key: normalized(incoming.title),
            sense_key: normalized(incoming.sense_key), examples: compactExamples(incoming.examples),
            additional_senses: [], note: null, scenes_custom: false, created_at: occurredAt,
            last_seen_at: occurredAt, encounter_count: 1, repeat_priority: 0, status: 'new',
            last_reviewed_at: null, last_review_result: null };
          point.search_text = this.searchText(point);
          point = await this.persistPoint(client, point, true);
          await this.setScenes(client, point.id, incoming.scenes ?? inferScenes(incoming));
          action = 'added';
        } else {
          const labels = await this.labels(client, point.id);
          const merged = incoming.scenes != null && !point.scenes_custom ? uniqueScenes([...labels, ...incoming.scenes]) : labels;
          if (merged.length > 12) {
            results.push({ index, status: 'failed', error: 'scene_limit_exceeded' });
            continue;
          }
          const previous = (await client.query('SELECT id FROM lm_encounters WHERE tenant_id=$1 AND point_id=$2 AND request_id=$3',
            [this.tenantId, point.id, requestId])).rowCount > 0;
          const sameSense = normalized(incoming.sense_key) === point.sense_key;
          if (incoming.kind === 'word') point.additional_senses = mergeSense(point, incoming);
          if (!previous) { point.encounter_count++; point.repeat_priority++; }
          point.last_seen_at = occurredAt;
          if (sameSense) {
            if (incoming.context != null) point.context = incoming.context;
            point.explanation ||= incoming.explanation;
            point.corrected_sentence ||= incoming.corrected_sentence;
            if (point.note == null && new Set(point.examples.map((e) => normalized(e.text))).size < 2) {
              const originals = new Set(point.examples.map((e) => normalized(e.text)));
              point.examples = [...point.examples, ...compactExamples(incoming.examples.filter((e) => !originals.has(normalized(e.text))))].slice(0, 5);
            }
          }
          point.search_text = this.searchText(point);
          point = await this.persistPoint(client, point);
          if (encode(merged) !== encode(labels)) await this.setScenes(client, point.id, merged);
          action = 'merged';
        }
        const entry = (await client.query('SELECT id,context FROM lm_encounters WHERE tenant_id=$1 AND point_id=$2 AND request_id=$3',
          [this.tenantId, point.id, requestId])).rows[0];
        if (entry) {
          const context = [...new Set([entry.context, incoming.context].filter(Boolean))].join('\n\n') || null;
          await client.query('UPDATE lm_encounters SET context=$4 WHERE tenant_id=$1 AND point_id=$2 AND request_id=$3',
            [this.tenantId, point.id, requestId, context]);
        } else {
          await client.query(`INSERT INTO lm_encounters(tenant_id,point_id,request_id,occurred_at,context,source)
            VALUES($1,$2,$3,$4,$5,$6)`, [this.tenantId, point.id, requestId, occurredAt, incoming.context, source]);
        }
        await client.query('UPDATE lm_tenants SET content_version=content_version+1 WHERE id=$1', [this.tenantId]);
        results.push({ index, status: action, id: point.id, encounter_count: point.encounter_count });
      }
      await client.query('INSERT INTO lm_save_requests(tenant_id,request_id,fingerprint,results) VALUES($1,$2,$3,$4::jsonb)',
        [this.tenantId, requestId, digest, json(results)]);
      return { status: 'processed', replayed: false, results };
    });
  }

  filters(input = {}, values = [this.tenantId]) {
    const clauses = ['p.tenant_id=$1'];
    const add = (value) => { values.push(value); return `$${values.length}`; };
    validateDatabaseText(input);
    for (const column of ['kind', 'status']) if (input[column] != null) clauses.push(`p.${column}=${add(input[column])}`);
    if (input.language != null) {
      const language = input.language.toLowerCase();
      clauses.push(input.include_variants
        ? `(p.language=${add(language)} OR starts_with(p.language,${add(`${language}-`)}))`
        : `p.language=${add(language)}`);
    }
    if (input.keyword != null) clauses.push(`strpos(p.search_text,${add(normalized(input.keyword))})>0`);
    if (input.scene != null) clauses.push(`EXISTS(SELECT 1 FROM lm_point_scenes ps
      WHERE ps.tenant_id=$1 AND ps.point_id=p.id AND ps.scene_key=${add(normalized(input.scene))})`);
    return { clauses, values, add };
  }

  async query(input = {}) {
    const scopeInput = { keyword: null, kind: null, language: null, status: null, scene: null,
      limit: 10, offset: 0, include_variants: false, cursor: null, needs_enrichment: false, ...input };
    const { keyword, kind, language, status, scene, offset, cursor, include_variants, needs_enrichment } = scopeInput;
    const limit = limitValue(scopeInput.limit);
    if (!Number.isInteger(offset) || offset < 0) throw new ValidationError();
    const { clauses, values, add } = this.filters(scopeInput);
    const term = normalized(keyword ?? '');
    const termSlot = term ? add(term) : null;
    const rank = term ? `CASE WHEN p.title_key=${termSlot} THEN 0 WHEN starts_with(p.title_key,${termSlot}) THEN 1
      WHEN strpos(p.title_key,${termSlot})>0 THEN 2 ELSE 3 END` : '0';
    const scope = fingerprint([this.tenantId, term, kind, language, status, scene, include_variants, needs_enrichment]);
    const outer = [];
    if (cursor != null) {
      try {
        if (typeof cursor !== 'string' || cursor.length > 2000 || !/^[A-Za-z0-9_=-]+$/.test(cursor)) throw new Error();
        const [score, time, id, digest] = JSON.parse(Buffer.from(cursor, 'base64url').toString());
        if (!Number.isInteger(score) || score < 0 || score > 3 || !Number.isSafeInteger(id) || id < 1
          || digest !== scope || offset || typeof time !== 'string' || !Number.isFinite(Date.parse(time))) throw new Error();
        const scoreSlot = add(score); const timeSlot = add(time); const idSlot = add(id);
        outer.push(`(search_rank>${scoreSlot} OR (search_rank=${scoreSlot} AND
          (last_seen_at<${timeSlot}::timestamptz OR (last_seen_at=${timeSlot}::timestamptz AND id<${idSlot}))))`);
      } catch { throw new ValidationError(); }
    }
    return this.transaction(false, async (client) => {
      const statement = `SELECT * FROM(SELECT p.*,${rank} AS search_rank FROM lm_points p
        WHERE ${clauses.join(' AND ')}) ranked ${outer.length ? `WHERE ${outer.join(' AND ')}` : ''}
        ORDER BY search_rank ASC,last_seen_at DESC,id DESC`;
      let rows;
      if (needs_enrichment) {
        rows = (await client.query(statement, values)).rows.filter((point) => point.note == null
          && (!point.explanation || new Set(point.examples.map((e) => normalized(e.text))).size < 2))
          .slice(offset, offset + limit + 1);
      } else {
        rows = (await client.query(`${statement} LIMIT ${add(limit + 1)} OFFSET ${add(offset)}`, values)).rows;
      }
      const records = [];
      for (const point of rows.slice(0, limit)) records.push(await this.record(client, point));
      const more = rows.length > limit;
      const last = rows[limit - 1];
      const nextCursor = more ? Buffer.from(encode([last.search_rank, timestamp(last.last_seen_at), last.id, scope]))
        .toString('base64').replaceAll('+', '-').replaceAll('/', '_') : null;
      return { records, has_more: more, next_cursor: nextCursor };
    });
  }

  async getPoint(id) {
    idValue(id);
    return this.transaction(false, async (client) => {
      const point = await this.point(client, id);
      return point ? { status: 'found', record: await this.record(client, point) } : { status: 'not_found' };
    });
  }

  async update(id, rawPatch, expectedRevision = null) {
    idValue(id);
    const changes = validatePatch(rawPatch);
    validateDatabaseText(changes);
    if (!Object.keys(changes).length) return { status: 'failed', error: 'empty_patch' };
    for (const key of ['title', 'sense_key', 'meaning', 'status', 'review_result', 'scenes']) {
      if (Object.hasOwn(changes, key) && changes[key] == null) return { status: 'failed', error: `${key}_cannot_be_null` };
    }
    if (Object.hasOwn(changes, 'review_result')) return { status: 'failed', error: 'use_record_review_with_request_id' };
    return this.transaction(true, async (client) => {
      const point = await this.point(client, id);
      if (!point) return { status: 'not_found' };
      const current = await this.record(client, point);
      if (expectedRevision != null && current.revision !== expectedRevision) {
        return { status: 'failed', error: 'edit_conflict', record: current };
      }
      const identity = this.identity(point.kind, point.language, changes.title ?? point.title, changes.sense_key ?? point.sense_key);
      if ((await client.query('SELECT id FROM lm_points WHERE tenant_id=$1 AND identity_key=$2 AND id<>$3',
        [this.tenantId, identity, id])).rowCount) return { status: 'failed', error: 'identity_conflict' };
      const labels = changes.scenes;
      delete changes.scenes;
      for (const [key, rawValue] of Object.entries(changes)) {
        const value = key === 'examples' && rawValue == null ? [] : rawValue;
        point[key] = key === 'sense_key' ? normalized(value) : value;
      }
      point.identity_key = identity;
      point.title_key = normalized(point.title);
      if (labels != null) { await this.setScenes(client, id, labels); point.scenes_custom = true; }
      point.search_text = this.searchText(point);
      const updated = await this.persistPoint(client, point);
      await client.query('UPDATE lm_tenants SET content_version=content_version+1 WHERE id=$1', [this.tenantId]);
      return { status: 'updated', record: await this.record(client, updated) };
    });
  }

  async delete(id) {
    idValue(id);
    return this.transaction(true, async (client) => {
      const result = await client.query('DELETE FROM lm_points WHERE tenant_id=$1 AND id=$2', [this.tenantId, id]);
      if (result.rowCount) await client.query('UPDATE lm_tenants SET content_version=content_version+1 WHERE id=$1', [this.tenantId]);
      return { status: result.rowCount ? 'deleted' : 'not_found', id };
    });
  }

  async scenes(input = {}) {
    const { clauses, values } = this.filters({ language: input.language, kind: input.kind,
      include_variants: input.include_variants ?? false });
    return this.transaction(false, async (client) => {
      const rows = (await client.query(`SELECT s.name,COUNT(*)::integer AS count FROM lm_points p
        JOIN lm_point_scenes ps ON ps.tenant_id=p.tenant_id AND ps.point_id=p.id
        JOIN lm_scenes s ON s.tenant_id=ps.tenant_id AND s.key=ps.scene_key
        WHERE s.tenant_id=$1 AND ps.tenant_id=$1 AND ${clauses.join(' AND ')} GROUP BY s.key,s.name ORDER BY s.key`, values)).rows;
      const total = (await client.query(`SELECT COUNT(DISTINCT p.id)::integer AS total FROM lm_points p
        JOIN lm_point_scenes ps ON ps.tenant_id=p.tenant_id AND ps.point_id=p.id
        WHERE ps.tenant_id=$1 AND ${clauses.join(' AND ')}`, values)).rows[0].total;
      return { scenes: rows, total };
    });
  }

  async languages() {
    return this.transaction(false, async (client) => {
      const rows = (await client.query('SELECT language,kind,COUNT(*)::integer AS total FROM lm_points WHERE tenant_id=$1 GROUP BY language,kind',
        [this.tenantId])).rows;
      const languages = new Set(); const counts = {}; const kinds = {}; const by_language = {};
      for (const { language, kind, total } of rows) {
        const base = language.split('-')[0]; languages.add(language); languages.add(base);
        counts[base] = (counts[base] ?? 0) + total; kinds[kind] = (kinds[kind] ?? 0) + total;
        by_language[base] ??= {}; by_language[base][kind] = (by_language[base][kind] ?? 0) + total;
      }
      return { languages: [...languages].sort(), counts, kinds, by_language };
    });
  }

  async recordReview(id, requestId, rawReview) {
    idValue(id); validateRequestId(requestId);
    const review = validateReview(rawReview);
    validateDatabaseText(review);
    const digest = fingerprint([id, review]);
    return this.transaction(true, async (client) => {
      const receipt = (await client.query('SELECT * FROM lm_review_requests WHERE tenant_id=$1 AND request_id=$2',
        [this.tenantId, requestId])).rows[0];
      if (receipt) {
        if (receipt.fingerprint !== digest) return { status: 'failed', error: 'request_id_conflict' };
        const result = clone(receipt.result);
        if (!await this.point(client, id)) result.deleted = true;
        return { ...result, replayed: true };
      }
      const point = await this.point(client, id);
      if (!point) return { status: 'not_found' };
      const occurredAt = now();
      const state = (await client.query('SELECT * FROM lm_memory_states WHERE tenant_id=$1 AND point_id=$2', [this.tenantId, id])).rows[0];
      let serialized = state?.card ?? null; let ratedReviews = state?.rated_reviews ?? 0;
      const rating = recallRating(review);
      let prediction = null; let log = null;
      if (rating != null) {
        let result;
        try { result = advance(id, serialized, rating, occurredAt); }
        catch (error) {
          if (error.message === 'clock_moved_backwards') return { status: 'failed', error: error.message };
          throw error;
        }
        serialized = result.card; prediction = result.prediction; log = result.log; ratedReviews++;
        await client.query(`INSERT INTO lm_memory_states(tenant_id,point_id,card,due_at,rated_reviews,algorithm)
          VALUES($1,$2,$3,$4,$5,$6::jsonb) ON CONFLICT(tenant_id,point_id) DO UPDATE SET
          card=EXCLUDED.card,due_at=EXCLUDED.due_at,rated_reviews=EXCLUDED.rated_reviews,algorithm=EXCLUDED.algorithm`,
        [this.tenantId, id, serialized, result.due_at, ratedReviews, json(ALGORITHM)]);
      }
      const event = (await client.query(`INSERT INTO lm_review_events
        (tenant_id,point_id,occurred_at,result,assisted,effort,prompt,answer,rating,predicted_recall,fsrs_log,algorithm)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb) RETURNING id`,
      [this.tenantId, id, occurredAt, review.result, review.assisted, review.effort, review.prompt,
        review.answer, rating, prediction, log, log == null ? null : json(ALGORITHM)])).rows[0];
      await client.query(`UPDATE lm_points SET last_reviewed_at=$3,last_review_result=$4,
        repeat_priority=CASE WHEN $5 THEN 0 ELSE repeat_priority END WHERE tenant_id=$1 AND id=$2`,
      [this.tenantId, id, occurredAt, review.result, review.result === 'correct' && !review.assisted]);
      await client.query('UPDATE lm_tenants SET content_version=content_version+1 WHERE id=$1', [this.tenantId]);
      const result = { status: 'reviewed', record_id: id, event_id: event.id, scheduled: rating != null,
        rating, memory: memorySnapshot(serialized, occurredAt, ratedReviews) };
      await client.query('INSERT INTO lm_review_requests(tenant_id,request_id,fingerprint,result) VALUES($1,$2,$3,$4::jsonb)',
        [this.tenantId, requestId, digest, json(result)]);
      return { ...result, replayed: false };
    });
  }

  async review(input = {}) {
    const limit = limitValue(input.limit ?? 5);
    const occurredAt = now();
    const { clauses, values, add } = this.filters({ ...input, status: 'new' });
    if (input.exclude_ids?.length) clauses.push(`NOT(p.id=ANY(${add(input.exclude_ids)}::integer[]))`);
    return this.transaction(false, async (client) => {
      const rows = (await client.query(`SELECT p.*,m.card,m.due_at,m.rated_reviews FROM lm_points p
        LEFT JOIN lm_memory_states m ON m.tenant_id=$1 AND m.point_id=p.id WHERE ${clauses.join(' AND ')}`, values)).rows
        .filter((point) => point.note == null || normalized(point.note));
      const due = rows.filter((p) => p.due_at != null && timestamp(p.due_at) <= occurredAt);
      const upcoming = rows.filter((p) => p.due_at != null && timestamp(p.due_at) > occurredAt);
      const counts = { eligible: rows.length, due: due.length, unassessed: rows.filter((p) => p.card == null).length, upcoming: upcoming.length };
      const reason = (p) => p.repeat_priority ? 0 : p.card == null ? 2 : timestamp(p.due_at) <= occurredAt ? 1 : 3;
      const eligible = rows.filter((p) => input.include_upcoming || p.repeat_priority || p.card == null || timestamp(p.due_at) <= occurredAt);
      eligible.sort((a, b) => reason(a) - reason(b) || b.repeat_priority - a.repeat_priority
        || (timestamp(a.due_at) ?? '').localeCompare(timestamp(b.due_at) ?? '')
        || timestamp(a.created_at).localeCompare(timestamp(b.created_at)) || a.id - b.id);
      const records = [];
      for (const point of eligible.slice(0, limit)) {
        const record = await this.record(client, point);
        record.memory = memorySnapshot(point.card ?? null, occurredAt, point.rated_reviews ?? 0);
        record.review_reason = ['repeated_question', 'due', 'unassessed', 'upcoming'][reason(point)];
        const latest = (await client.query(`SELECT occurred_at,result,assisted,prompt,answer FROM lm_review_events
          WHERE tenant_id=$1 AND point_id=$2 ORDER BY id DESC LIMIT 1`, [this.tenantId, point.id])).rows[0];
        record.last_attempt = latest ? { ...latest, occurred_at: timestamp(latest.occurred_at) } : null;
        records.push(record);
      }
      return { records, counts, next_due_at: upcoming.map((p) => timestamp(p.due_at)).sort()[0] ?? null,
        as_of: occurredAt, algorithm: ALGORITHM };
    });
  }

  get_point(id) { return this.getPoint(id); }
  record_review(id, requestId, review) { return this.recordReview(id, requestId, review); }
  reviewQueue(input) { return this.review(input); }
}
