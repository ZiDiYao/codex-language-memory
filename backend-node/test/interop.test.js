import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createPool } from '../src/database.js';
import { migrate } from '../src/migration.js';
import { Repository } from '../src/repository.js';

const enabled = !!(process.env.TEST_DATABASE_URL && process.env.PYTHON_EXECUTABLE);
const root = fileURLToPath(new URL('../../', import.meta.url));
const bridge = fileURLToPath(new URL('./python_bridge.py', import.meta.url));
const principal = { issuer: 'https://interop-issuer.example/', subject: 'shared-learner-ß' };
const point = {
  kind: 'word', language: 'en', title: 'Straße', sense_key: 'street', meaning: '街道',
  explanation: 'A street in a town, used here to exercise Unicode normalization.',
  examples: [{ text: 'This street is quiet.' }, { text: 'They live on the same street.' }],
  scenes: ['City & travel', 'Ｓｔｒａße'],
};

async function isolatedSchema(t) {
  const schema = `node_interop_${randomBytes(8).toString('hex')}`;
  const admin = createPool(process.env.TEST_DATABASE_URL);
  await admin.query(`CREATE SCHEMA "${schema}"`);
  const url = new URL(process.env.TEST_DATABASE_URL.replace(/^postgresql\+psycopg:/, 'postgresql:'));
  url.searchParams.set('options', `-c search_path=${schema}`);
  const pool = createPool(url.href);
  t.after(async () => {
    await pool.end();
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin.end();
  });
  const python = (method, args = [], kwargs = {}) => {
    const child = spawnSync(process.env.PYTHON_EXECUTABLE, [bridge], {
      cwd: root, env: { ...process.env, DATABASE_URL: url.href }, encoding: 'utf8', timeout: 30_000,
      input: JSON.stringify({ method, principal, args, kwargs }),
    });
    // Do not expose database URLs, SQL parameters or learning data from stderr.
    assert.equal(child.status, 0, `Python bridge failed for ${method}`);
    return JSON.parse(child.stdout);
  };
  return { pool, python, repository: new Repository(pool, principal) };
}

test('Shared base migration matches Python; Node extensions preserve Python CRUD compatibility', { skip: !enabled }, async t => {
  const first = await isolatedSchema(t);
  // Alembic owns only the shared base tables. Its exact-metadata check runs
  // before applying the independently versioned, additive Node extension.
  assert.equal((await migrate(first.pool, { baseOnly: true })).status, 'migrated');
  assert.equal(first.python('schema_check').status, 'ok');
  assert.equal((await migrate(first.pool)).status, 'migrated');
  assert.equal((await migrate(first.pool)).status, 'current');
  const second = await isolatedSchema(t);
  assert.equal(second.python('migrate').status, 'ok');
  assert.equal((await migrate(second.pool)).status, 'migrated');
  assert.equal((await migrate(second.pool)).status, 'current');
  assert.equal(second.python('settings').enabled, true);
});

test('Node and Python share identities, receipts, revisions, scenes, senses and review cards', { skip: !enabled }, async t => {
  const { pool, python, repository } = await isolatedSchema(t);
  await migrate(pool);
  const saved = await repository.save('interop-capture-node', [point]);
  assert.equal(saved.results[0].status, 'added');
  const id = saved.results[0].id;
  assert.equal((await repository.versions()).latest_point_id, id);
  assert.deepEqual(python('versions'), await repository.versions());
  assert.equal(python('save', ['interop-capture-node', [point]]).replayed, true);
  const fromNode = (await repository.get_point(id)).record;
  const fromPython = python('get_point', [id]).record;
  assert.equal(fromNode.revision, fromPython.revision);
  assert.deepEqual(fromNode.scenes, fromPython.scenes);
  assert.equal(fromNode.note, fromPython.note);
  assert.equal(fromPython.encounter_count, 1);

  const changed = python('update', [id, { note: '# My street note\nRemember this one.', scenes: ['Everyday life'] }, fromNode.revision]);
  assert.equal(changed.status, 'updated');
  assert.equal((await repository.update(id, { note: 'stale edit' }, fromNode.revision)).error, 'edit_conflict');
  assert.equal((await repository.get_point(id)).record.revision, changed.record.revision);
  const nodeEdit = await repository.update(id, { scenes: [] }, changed.record.revision);
  assert.equal(nodeEdit.status, 'updated');
  assert.equal(python('get_point', [id]).record.revision, nodeEdit.record.revision);

  const alternate = { ...point, title: 'STRASSE', sense_key: 'road', meaning: '道路' };
  const pySaved = python('save', ['interop-capture-python', [alternate]]);
  assert.equal(pySaved.results[0].id, id);
  assert.equal((await repository.save('interop-capture-python', [alternate])).replayed, true);
  const both = (await repository.query({ keyword: 'strasse' })).records;
  assert.equal(both.length, 1);
  assert.equal(both[0].encounter_count, 2);
  assert.equal(both[0].additional_senses.length, 1);
  assert.equal(both[0].revision, python('get_point', [id]).record.revision);

  const review = { result: 'correct', prompt: 'What does this mean?', answer: '街道' };
  assert.equal((await repository.record_review(id, 'interop-review-node', review)).scheduled, true);
  assert.equal(python('record_review', [id, 'interop-review-node', review]).replayed, true);
  assert.equal(python('record_review', [id, 'interop-review-python', review]).scheduled, true);
  assert.equal((await repository.record_review(id, 'interop-review-python', review)).replayed, true);
  const queue = await repository.review({ include_upcoming: true });
  assert.equal(queue.records[0].memory.rated_reviews, 2);
  assert.ok(Number.isFinite(queue.records[0].memory.estimated_recall));
  assert.equal(python('review', [], { include_upcoming: true }).records[0].memory.rated_reviews, 2);
  assert.equal(Number((await pool.query('SELECT count(*) FROM lm_review_events')).rows[0].count), 2);

  assert.equal((await repository.settings({ explanation_language: 'zh' })).explanation_language, 'zh');
  assert.equal(python('settings').explanation_language, 'zh');
  python('settings', [{ enabled: false }]);
  assert.equal((await repository.settings()).enabled, false);
  const other = new Repository(pool, { ...principal, subject: 'another-learner' });
  assert.deepEqual(await other.versions(), { content: 0, preferences: 0, latest_point_id: 0 });
  assert.deepEqual((await other.query({})).records, []);
  assert.equal((await other.get_point(id)).status, 'not_found');
});
