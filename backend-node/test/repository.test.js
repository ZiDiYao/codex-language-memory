import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { createPool, checkSchema, timestamp } from '../src/database.js';
import { migrate } from '../src/migration.js';
import { Repository } from '../src/repository.js';

const url = process.env.TEST_DATABASE_URL;
const point = {
  kind: 'word', language: 'en', title: 'rinse', sense_key: 'wash', meaning: '冲洗',
  explanation: 'Rinse something with water.',
  examples: [{ text: 'Rinse your mouth.', translation: '漱口。' }, { text: 'Rinse the cup.' }],
  scenes: ['Cleaning & hygiene', 'At home'],
};

describe('PostgreSQL Node repository', { skip: !url, concurrency: false }, () => {
  let admin; let pool;
  const schema = `node_repo_${randomUUID().replaceAll('-', '')}`;
  const principal = (name) => ({ issuer: 'https://identity.example/', subject: `${schema}-${name}` });
  const repo = (name) => new Repository(pool, principal(name));
  const save = async (repository, overrides = {}, requestId = `save-${randomUUID()}`) => {
    const result = await repository.save(requestId, [{ ...point, ...overrides }]);
    assert.equal(result.results[0].status, 'added');
    return result.results[0].id;
  };

  before(async () => {
    admin = createPool(url);
    await admin.query(`CREATE SCHEMA ${schema}`);
    pool = createPool(url, { options: `-c search_path=${schema}` });
    assert.equal((await migrate(pool)).status, 'migrated');
  });
  after(async () => {
    await pool?.end();
    if (admin) {
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await admin.end();
    }
  });

  test('migration is concurrent-safe, non-destructive, and rejects unknown heads', async () => {
    const repository = repo('migration');
    const id = await save(repository);
    const results = await Promise.all([migrate(pool), migrate(pool), migrate(pool)]);
    assert.ok(results.every((result) => result.status === 'current'));
    assert.equal(await checkSchema(pool), true);
    assert.equal((await repository.getPoint(id)).status, 'found');
    await pool.query("UPDATE alembic_version SET version_num='future_unsupported'");
    await assert.rejects(migrate(pool), /Unsupported/);
    assert.equal((await repository.getPoint(id)).status, 'found');
    await pool.query("UPDATE alembic_version SET version_num='0001_remote_storage'");
  });

  test('principal controls isolation across every query, mutation, and receipt', async () => {
    const alice = repo('alice'); const bob = repo('bob');
    const id = await save(alice, {}, 'identical-request');
    assert.deepEqual((await bob.query()).records, []);
    assert.deepEqual((await bob.scenes()).scenes, []);
    assert.deepEqual((await bob.languages()).languages, []);
    assert.equal((await bob.getPoint(id)).status, 'not_found');
    assert.equal((await bob.update(id, { note: 'stolen' })).status, 'not_found');
    assert.equal((await bob.delete(id)).status, 'not_found');
    assert.equal((await bob.recordReview(id, 'identical-review', { result: 'correct' })).status, 'not_found');
    assert.deepEqual((await bob.review()).records, []);
    const sameSubject = new Repository(pool, { issuer: 'https://different.example/', subject: principal('alice').subject });
    assert.deepEqual((await sameSubject.query()).records, []);
    const forged = new Repository(pool, { ...principal('bob'), user_id: alice.tenantId });
    assert.deepEqual((await forged.query()).records, []);
    const otherId = await save(bob, {}, 'identical-request');
    assert.notEqual(id, otherId);
    await bob.settings({ first_language: 'fr', enabled: false });
    assert.equal((await alice.settings()).enabled, true);
    assert.equal((await alice.settings()).first_language, null);
  });

  test('word senses and retries share one encounter, preserve edits, and cannot resurrect deleted points', async () => {
    const repository = repo('meanings');
    const batch = [point, { ...point, sense_key: 'food rinse', meaning: '冲掉食物杂质', scenes: ['Cooking'] }];
    const result = await repository.save('word-two-meanings', batch);
    assert.deepEqual(result.results.map((r) => r.status), ['added', 'merged']);
    const id = result.results[0].id;
    assert.equal(result.results[1].encounter_count, 1);
    let record = (await repository.getPoint(id)).record;
    assert.equal(record.additional_senses.length, 1);
    assert.deepEqual(record.scenes, ['Cleaning & hygiene', 'At home', 'Cooking']);
    const replay = await repository.save('word-two-meanings', batch);
    assert.equal(replay.replayed, true);
    assert.deepEqual(replay.results, result.results);
    assert.equal((await repository.save('word-two-meanings', [point])).error, 'request_id_conflict');
    await repository.update(id, { note: 'rinse\nMy own note' });
    await repository.save('word-next-encounter', [point]);
    record = (await repository.getPoint(id)).record;
    assert.equal(record.note, 'rinse\nMy own note');
    assert.equal(record.encounter_count, 2);
    await repository.delete(id);
    assert.equal((await repository.save('word-two-meanings', batch)).results[0].deleted, true);
    assert.deepEqual((await repository.query()).records, []);
  });

  test('scenes overlap across types and compose with language and kind, including Unicode normalization', async () => {
    const repository = repo('scenes');
    const id = await save(repository);
    await save(repository, { kind: 'expression', title: 'wash your hands', scenes: ['Cleaning & hygiene'] });
    const regional = await save(repository, { language: 'en-CA', title: 'wipe', scenes: ['Cleaning & hygiene'] });
    await save(repository, { language: 'fr', title: 'rincer', scenes: ['Cleaning & hygiene'] });
    assert.equal((await repository.query({ language: 'en', scene: 'cleaning & hygiene' })).records.length, 2);
    assert.deepEqual(new Set((await repository.query({ language: 'en', kind: 'word', scene: 'Cleaning & hygiene', include_variants: true })).records.map((r) => r.id)), new Set([id, regional]));
    const scenes = await repository.scenes({ language: 'en' });
    assert.equal(scenes.total, 2);
    assert.equal(scenes.scenes.reduce((sum, s) => sum + s.count, 0), 3);
    const unicodeId = await save(repository, { title: 'ß'.repeat(80), sense_key: 'ß'.repeat(150), scenes: ['ß'.repeat(80)] });
    assert.equal((await repository.query({ scene: 'ss'.repeat(80) })).records[0].id, unicodeId);
    const repeated = await repository.save('unicode-repeat', [{ ...point, title: 'SS'.repeat(80), scenes: ['ß'.repeat(80)] }]);
    assert.equal(repeated.results[0].id, unicodeId);
  });

  test('optimistic revisions and manual scene edits survive repeated capture', async () => {
    const repository = repo('editing'); const id = await save(repository);
    const revision = (await repository.getPoint(id)).record.revision;
    assert.equal((await repository.update(id, { scenes: ['At home'] }, revision)).status, 'updated');
    assert.equal((await repository.update(id, { note: 'lost edit' }, revision)).error, 'edit_conflict');
    await repository.save('after-manual-subset', [point]);
    assert.deepEqual((await repository.getPoint(id)).record.scenes, ['At home']);
    await repository.update(id, { scenes: [] });
    await repository.save('after-manual-clear', [point]);
    assert.deepEqual((await repository.getPoint(id)).record.scenes, []);
    const second = await save(repository, { title: 'wipe' });
    assert.equal((await repository.update(second, { title: 'rinse', scenes: ['Other'] })).error, 'identity_conflict');
    assert.equal((await repository.getPoint(second)).record.title, 'wipe');
  });

  test('concurrent saves and reviews commit once while mastery remains user controlled', async () => {
    const repository = repo('concurrency');
    const saves = await Promise.all(Array.from({ length: 6 }, () => repository.save('concurrent-save', [point])));
    assert.equal(saves.filter((r) => !r.replayed).length, 1);
    const id = saves[0].results[0].id;
    const assisted = await repository.recordReview(id, 'assisted-review', { result: 'correct', assisted: true, answer: 'rinse' });
    assert.equal(assisted.scheduled, false);
    const partial = await repository.recordReview(id, 'partial-review', { result: 'partial', answer: 'wash' });
    assert.equal(partial.rating, 1);
    const reviews = await Promise.all(Array.from({ length: 6 }, () => repository.recordReview(id, 'concurrent-review', { result: 'correct', answer: 'rinse' })));
    assert.equal(reviews.filter((r) => !r.replayed).length, 1);
    assert.equal(new Set(reviews.map((r) => r.event_id)).size, 1);
    assert.equal(reviews[0].memory.rated_reviews, 2);
    assert.equal((await repository.getPoint(id)).record.status, 'new');
    await repository.update(id, { status: 'mastered' });
    await repository.recordReview(id, 'failed-after-mastery', { result: 'incorrect', answer: '?' });
    assert.equal((await repository.getPoint(id)).record.status, 'mastered');
    assert.deepEqual((await repository.review({ include_upcoming: true })).records, []);
    await repository.delete(id);
    assert.equal((await repository.recordReview(id, 'concurrent-review', { result: 'correct', answer: 'rinse' })).deleted, true);
  });

  test('microsecond keyset cursors do not drop Python-origin rows', async () => {
    const repository = repo('cursor');
    const ids = [];
    for (let i = 0; i < 3; i++) ids.push(await save(repository, { title: `item ${i}` }));
    for (const [index, id] of ids.entries()) {
      await pool.query('UPDATE lm_points SET last_seen_at=$3 WHERE tenant_id=$1 AND id=$2',
        [repository.tenantId, id, `2026-11-22T12:00:00.12345${index}+00:00`]);
    }
    const found = [];
    let cursor = null;
    do {
      const page = await repository.query({ limit: 1, cursor });
      found.push(...page.records.map((r) => r.id));
      cursor = page.next_cursor;
    } while (cursor);
    assert.deepEqual(found, [...ids].reverse());
    assert.equal((await repository.getPoint(ids[0])).record.last_seen_at, '2026-11-22T12:00:00.123450+00:00');
    assert.equal(timestamp(new Date('2026-11-22T12:00:00.123Z')), '2026-11-22T12:00:00.123000+00:00');
  });

  test('partial invalid capture is idempotent and cross-tenant composite foreign keys hold', async () => {
    const repository = repo('invalid'); const other = repo('invalid-other');
    const items = [{ ...point, meaning: 'bad\u0000text' }, { kind: 'word' }, point];
    const result = await repository.save('partial-invalid-batch', items);
    assert.deepEqual(result.results.map((r) => r.status), ['failed', 'failed', 'added']);
    assert.equal((await repository.save('partial-invalid-batch', items)).replayed, true);
    const id = result.results[2].id;
    await save(other, { scenes: ['Private'] });
    await assert.rejects(pool.query(`INSERT INTO lm_point_scenes(tenant_id,point_id,scene_key,position)
      VALUES($1,$2,'private',0)`, [other.tenantId, id]), (error) => error.code === '23503');
    assert.deepEqual((await repository.getPoint(id)).record.scenes, point.scenes);
  });
});
