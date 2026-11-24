import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { createPool } from '../src/database.js';
import { migrate } from '../src/migration.js';
import { Repository } from '../src/repository.js';

const url = process.env.TEST_DATABASE_URL;
const raw = { kind: 'word', language: 'en', title: 'celery', context: '芹菜的英文咋说' };
const dbtest = (name, run) => test(name, { skip: !url, timeout: 15000 }, run);

async function fixture(t) {
  const schema = `enrich_dedup_${randomUUID().replaceAll('-', '')}`;
  const admin = createPool(url);
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = createPool(url, { options: `-c search_path=${schema}` });
  await migrate(pool);
  t.after(async () => {
    await pool.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  });
  const principal = { issuer: 'https://dedup.example/', subject: 'alice' };
  const repo = new Repository(pool, principal);
  const jobs = async repository => (await pool.query(
    'SELECT * FROM lm_enrichment_jobs WHERE tenant_id=$1 ORDER BY id', [repository.tenantId])).rows;
  return { pool, repo, principal, jobs };
}

dbtest('identical pending work is reused while each real encounter and replay keeps its own receipt', async t => {
  const { pool, repo, jobs } = await fixture(t);
  const first = await repo.observe('dedup-first-request', [raw]);
  const second = await repo.observe('dedup-second-request', [raw]);
  const id = first.results[0].id;
  assert.equal(second.results[0].id, id);
  assert.equal(second.results[0].status, 'merged');
  assert.equal(second.results[0].enrichment_state, 'pending');
  assert.equal(second.results[0].encounter_count, 2);
  assert.equal((await jobs(repo)).length, 1);
  assert.equal((await jobs(repo))[0].request_id, 'dedup-first-request');
  for (const request of ['dedup-first-request', 'dedup-second-request']) {
    assert.equal((await repo.observe(request, [raw])).replayed, true);
  }
  assert.equal((await repo.getPoint(id)).record.encounter_count, 2);
  assert.equal((await pool.query('SELECT count(*)::integer n FROM lm_encounters')).rows[0].n, 2);
  assert.equal((await pool.query('SELECT count(*)::integer n FROM lm_save_requests')).rows[0].n, 2);
  assert.equal((await jobs(repo)).length, 1);
});

dbtest('concurrent distinct encounters coalesce one pending job without losing evidence', async t => {
  const { repo, jobs } = await fixture(t);
  const results = await Promise.all(Array.from({ length: 6 }, (_, index) =>
    repo.observe(`concurrent-dedup-${index}`, [raw])));
  assert.equal(new Set(results.map(result => result.results[0].id)).size, 1);
  assert.equal(results.filter(result => result.results[0].status === 'added').length, 1);
  assert.equal((await jobs(repo)).length, 1);
  assert.equal((await repo.getPoint(results[0].results[0].id)).record.encounter_count, 6);
});

dbtest('different original contexts or already-given corrections retain separate pending work', async t => {
  const { repo, jobs } = await fixture(t);
  const observation = { kind: 'correction', language: 'en', title: 'very like',
    context: 'I very like it.', corrected_sentence: 'I really like it.' };
  const first = await repo.observe('context-original', [observation]);
  await repo.observe('context-different', [{ ...observation, context: 'I very like this place.' }]);
  await repo.observe('correction-different', [{ ...observation, corrected_sentence: 'I like it very much.' }]);
  assert.equal((await jobs(repo)).length, 3);
  assert.equal((await repo.getPoint(first.results[0].id)).record.encounter_count, 3);
});

dbtest('processing, completed and failed snapshots are never reused as pending enrichment', async t => {
  const { pool, repo, jobs } = await fixture(t);
  for (const [index, state] of ['processing', 'ready', 'failed'].entries()) {
    const input = { ...raw, title: `snapshot ${state}` };
    await repo.observe(`snapshot-first-${index}`, [input]);
    await pool.query(`UPDATE lm_enrichment_jobs SET state=$2 WHERE tenant_id=$1 AND input->>'title'=$3`,
      [repo.tenantId, state, input.title]);
    await repo.observe(`snapshot-second-${index}`, [input]);
    const matching = (await jobs(repo)).filter(job => job.input.title === input.title);
    assert.deepEqual(matching.map(job => job.state), [state, 'pending']);
  }
});

dbtest('pending deduplication stays tenant scoped and respects recording and custom notes', async t => {
  const { pool, repo, principal, jobs } = await fixture(t);
  const other = new Repository(pool, { ...principal, subject: 'bob' });
  const id = (await repo.observe('same-tenant-request', [raw])).results[0].id;
  await other.observe('same-tenant-request', [raw]);
  assert.equal((await jobs(repo)).length, 1);
  assert.equal((await jobs(other)).length, 1);
  assert.equal((await pool.query('SELECT count(*)::integer n FROM lm_encounters')).rows[0].n, 2);
  await repo.settings({ enabled: false });
  assert.equal((await repo.observe('paused-dedup-request', [raw])).status, 'paused');
  assert.equal((await repo.getPoint(id)).record.encounter_count, 1);
  await repo.settings({ enabled: true });
  await repo.update(id, { note: '' });
  const custom = await repo.observe('custom-note-request', [raw]);
  assert.equal(custom.results[0].enrichment_state, 'ready');
  assert.equal((await jobs(repo)).length, 1);
  assert.equal((await repo.getPoint(id)).record.note, '');
  assert.equal((await repo.getPoint(id)).record.encounter_count, 2);
});
