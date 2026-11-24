import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { createPool } from '../src/database.js';
import { migrate } from '../src/migration.js';
import { Repository } from '../src/repository.js';
import { claimEnrichment, completeEnrichment, runEnrichmentOnce, createOpenAIEnricher, MAX_ATTEMPTS } from '../src/enrichment.js';
const url = process.env.TEST_DATABASE_URL;
const raw = { kind: 'word', language: 'en', title: 'celery', context: '芹菜的英文咋说' };
const content = { sense_key: 'vegetable', meaning: '芹菜', explanation: 'Celery is usually uncountable.', corrected_sentence: null,
  examples: [{ text: 'Buy some celery.', translation: '买点芹菜。' }, { text: 'Add celery to the soup.' }], scenes: ['Food & cooking'] };
const rich = { ...raw, ...content };
async function fixture(t) {
  const schema = `enrich_${randomUUID().replaceAll('-', '')}`, admin = createPool(url);
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = createPool(url, { options: `-c search_path=${schema}` });
  await migrate(pool);
  t.after(async () => { await pool.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); });
  const principal = { issuer: 'https://test.example/', subject: 'alice' }, repo = new Repository(pool, principal);
  await repo.settings({ first_language: 'zh' });
  const save = (id = randomUUID(), input = raw) => repo.observe(id, [input]);
  return { pool, repo, save, principal };
}
const dbtest = (name, run) => test(name, { skip: !url, timeout: 15000 }, run);

dbtest('minimal observation persists raw target, encounter, receipt and job; retries never invent another encounter', async t => {
  const { pool, repo, save, principal } = await fixture(t);
  const result = await save('minimal-capture-1'), id = result.results[0].id;
  assert.equal(result.results[0].status, 'added');
  assert.equal(result.results[0].enrichment_state, 'pending');
  const record = (await repo.getPoint(id)).record;
  assert.equal(record.content_ready, false); assert.equal(record.meaning, ''); assert.deepEqual(record.examples, []);
  assert.equal(record.enrichment_state, 'pending');
  assert.equal((await repo.review({ include_upcoming: true })).records.length, 0);
  assert.equal((await save('minimal-capture-1')).replayed, true);
  assert.equal((await save('minimal-capture-1', { ...raw, title: 'different' })).error, 'request_id_conflict');
  const other = new Repository(pool, { ...principal, subject: 'bob' });
  assert.equal((await other.getPoint(id)).status, 'not_found'); assert.deepEqual((await other.query()).records, []);
  assert.equal((await other.observe('minimal-capture-1', [raw])).results[0].encounter_count, 1);
  assert.equal((await pool.query('SELECT count(*)::integer n FROM lm_encounters')).rows[0].n, 2);
  await repo.delete(id);
  assert.equal((await save('minimal-capture-1')).results[0].deleted, true);
});

dbtest('settings, partial failures, normalized identity and concurrent retries are enforced', async t => {
  const { repo, save, pool } = await fixture(t);
  await repo.settings({ enabled: false }); assert.equal((await save()).status, 'paused');
  assert.equal((await pool.query('SELECT count(*)::integer n FROM lm_enrichment_jobs')).rows[0].n, 0);
  await repo.settings({ enabled: true, enabled_types: ['word'] });
  const partial = await repo.observe('partial-observation', [{ ...raw, kind: 'grammar' }, { ...raw, title: '\u0000' }, raw]);
  assert.deepEqual(partial.results.map(r => r.status), ['skipped', 'failed', 'added']);
  const normalized = await save('normalize-observation', { ...raw, title: ' ＣＥＬＥＲＹ ' });
  assert.equal(normalized.results[0].id, partial.results[2].id);
  const all = await Promise.all(Array.from({ length: 6 }, () => save('concurrent-observation')));
  assert.equal(all.filter(r => !r.replayed).length, 1);
  assert.equal((await repo.getPoint(partial.results[2].id)).record.encounter_count, 3);
  assert.equal((await repo.save('concurrent-observation', [rich])).error, 'request_id_conflict');
});

dbtest('single-call capture returns current preferences on replay without another encounter', async t => {
  const { repo, pool } = await fixture(t);
  const original = await repo.observe('context-shared-request', [raw]);
  assert.equal('_context' in original, false);
  await repo.settings({ first_language: 'fr', explanation_language: 'ja', enabled_types: ['word'] });
  const replay = await repo.observeWithContext('context-shared-request', [raw]);
  assert.equal(replay.replayed, true);
  assert.equal(replay.results[0].id, original.results[0].id);
  assert.deepEqual(replay._context, { enabled: true, enabled_types: ['word'], first_language: 'fr', explanation_language: 'ja' });
  const conflict = await repo.observeWithContext('context-shared-request', [{ ...raw, title: 'rinse' }]);
  assert.equal(conflict.error, 'request_id_conflict');
  assert.deepEqual(conflict._context, replay._context);
  const captured = await repo.observeWithContext('context-first-request', [{ ...raw, title: 'rinse' }]);
  assert.equal(captured.results[0].enrichment_state, 'pending');
  assert.deepEqual(captured._context, replay._context);
  assert.equal((await repo.observe('context-first-request', [{ ...raw, title: 'rinse' }])).replayed, true);
  assert.equal((await pool.query('SELECT count(*)::integer n FROM lm_encounters')).rows[0].n, 2);
  assert.equal((await pool.query('SELECT count(*)::integer n FROM lm_enrichment_jobs')).rows[0].n, 2);
});

dbtest('single-call capture honors recording/type settings and isolates context to its tenant', async t => {
  const { repo, pool, principal } = await fixture(t);
  await repo.settings({ enabled: false, explanation_language: 'fr' });
  const paused = await repo.observeWithContext('context-paused-request', [raw]);
  assert.equal(paused.status, 'paused');
  assert.equal(paused._context.enabled, false);
  assert.equal(paused._context.explanation_language, 'fr');
  assert.equal((await pool.query('SELECT count(*)::integer n FROM lm_encounters')).rows[0].n, 0);
  await repo.settings({ enabled: true, enabled_types: ['grammar'] });
  const skipped = await repo.observeWithContext('context-type-request', [raw]);
  assert.equal(skipped.results[0].status, 'skipped');
  assert.deepEqual(skipped._context.enabled_types, ['grammar']);
  assert.equal((await pool.query('SELECT count(*)::integer n FROM lm_enrichment_jobs')).rows[0].n, 0);
  const other = new Repository(pool, { ...principal, subject: 'bob' });
  await other.settings({ first_language: 'ja' });
  const saved = await other.observeWithContext('context-type-request', [raw]);
  assert.equal(saved.results[0].status, 'added');
  assert.equal(saved._context.first_language, 'ja');
  assert.equal(saved._context.explanation_language, null);
  assert.deepEqual((await repo.query()).records, []);
  assert.equal((await repo.getPoint(saved.results[0].id)).status, 'not_found');
});

dbtest('background completion adds content and scenes without a new encounter or review', async t => {
  const { repo, pool, save } = await fixture(t); const id = (await save()).results[0].id;
  let prompt;
  assert.equal(await runEnrichmentOnce(pool, async value => { prompt = value; return content; }), true);
  assert.equal(prompt.explanation_language, 'zh'); assert.equal(prompt.target.context, raw.context);
  const record = (await repo.getPoint(id)).record;
  assert.equal(record.content_ready, true); assert.equal(record.enrichment_state, 'ready');
  assert.equal(record.meaning, '芹菜'); assert.equal(record.encounter_count, 1);
  assert.equal(record.last_review_result, null); assert.equal(record.status, 'new');
  assert.deepEqual(record.scenes, ['Food & cooking']);
  assert.equal((await repo.review({ include_upcoming: true })).records.length, 1);
  assert.equal(await runEnrichmentOnce(pool, async () => content), false);
});

dbtest('tenant locks skip safely; repeat encounters and mastery do not invalidate in-flight content', async t => {
  const { repo, pool, save } = await fixture(t); const id = (await save()).results[0].id;
  const job = await claimEnrichment(pool); const client = await pool.connect();
  await client.query('BEGIN'); await client.query('SELECT id FROM lm_tenants WHERE id=$1 FOR UPDATE', [repo.tenantId]);
  assert.equal(await claimEnrichment(pool), null);
  await client.query('COMMIT'); client.release();
  const [repeat, mastery] = await Promise.all([save(), repo.update(id, { status: 'mastered' })]);
  assert.equal(repeat.results[0].encounter_count, 2); assert.equal(mastery.status, 'updated');
  assert.equal((await completeEnrichment(job, content)).status, 'ready');
  assert.equal((await repo.getPoint(id)).record.status, 'mastered');
  assert.equal((await repo.getPoint(id)).record.encounter_count, 2);
  const next = await claimEnrichment(pool); assert.ok(next); await completeEnrichment(next, content);
  assert.equal((await repo.getPoint(id)).record.additional_senses.length, 0);
});

dbtest('expired leases recover durably and stale workers cannot commit; final lease expiry invalidates the feed', async t => {
  const { repo, pool, save } = await fixture(t); const id = (await save()).results[0].id;
  const first = await claimEnrichment(pool);
  await pool.query("UPDATE lm_enrichment_jobs SET lease_until=CURRENT_TIMESTAMP-INTERVAL '1 second' WHERE id=$1", [first.id]);
  const recovered = await claimEnrichment(pool); assert.equal(recovered.id, first.id); assert.notEqual(recovered.token, first.token);
  assert.equal((await completeEnrichment(first, content)).status, 'stale');
  assert.equal((await completeEnrichment(recovered, content)).status, 'ready');
  assert.equal((await repo.getPoint(id)).record.encounter_count, 1);
  await save(); const final = await claimEnrichment(pool); const version = (await repo.versions()).content;
  await pool.query("UPDATE lm_enrichment_jobs SET attempts=$2,lease_until=CURRENT_TIMESTAMP-INTERVAL '1 second' WHERE id=$1", [final.id, MAX_ATTEMPTS]);
  assert.equal(await claimEnrichment(pool), null);
  assert.equal((await repo.getPoint(id)).record.enrichment_state, 'failed');
  assert.ok((await repo.versions()).content > version);
});

dbtest('invalid providers remain visibly failed with retry backoff and bounded attempts', async t => {
  const { repo, pool, save } = await fixture(t); const id = (await save()).results[0].id;
  await runEnrichmentOnce(pool, async () => ({ ...content, examples: [] }));
  assert.equal((await repo.getPoint(id)).record.enrichment_state, 'failed'); assert.equal(await claimEnrichment(pool), null);
  for (let n = 1; n < MAX_ATTEMPTS; n++) {
    await pool.query('UPDATE lm_enrichment_jobs SET next_attempt_at=CURRENT_TIMESTAMP');
    assert.equal(await runEnrichmentOnce(pool, async () => { throw new Error('private provider detail'); }), true);
  }
  await pool.query('UPDATE lm_enrichment_jobs SET next_attempt_at=CURRENT_TIMESTAMP'); assert.equal(await claimEnrichment(pool), null);
  assert.equal((await repo.getPoint(id)).record.meaning, '');
  const job = (await pool.query('SELECT * FROM lm_enrichment_jobs')).rows[0];
  assert.equal(job.last_error, 'provider_failed'); assert.equal(job.attempts, MAX_ATTEMPTS);
});

dbtest('manual blank notes, scenes and deletion win against late AI; no point resurrection', async t => {
  const { repo, pool, save } = await fixture(t); const id = (await save()).results[0].id;
  const job = await claimEnrichment(pool); await repo.update(id, { note: '', scenes: [] });
  assert.equal((await completeEnrichment(job, content)).status, 'content_changed');
  const edited = (await repo.getPoint(id)).record; assert.equal(edited.note, ''); assert.deepEqual(edited.scenes, []);
  assert.equal(edited.enrichment_state, 'ready'); assert.equal((await save()).results[0].enrichment_state, 'ready');
  const deleted = (await save(undefined, { ...raw, title: 'delete me' })).results[0].id;
  const deletingJob = await claimEnrichment(pool); await repo.delete(deleted);
  assert.equal((await completeEnrichment(deletingJob, content)).status, 'stale');
  assert.equal((await repo.getPoint(deleted)).status, 'not_found');
});

dbtest('same generated sense deduplicates and new meaning merges on the original word', async t => {
  const { repo, pool, save } = await fixture(t); const id = (await repo.save('legacy-rich-capture', [rich])).results[0].id;
  await save(); await runEnrichmentOnce(pool, async () => content);
  assert.equal((await repo.getPoint(id)).record.additional_senses.length, 0);
  await save(undefined, { ...raw, context: 'A second explicitly asked meaning in context.' });
  await runEnrichmentOnce(pool, async () => ({ ...content, sense_key: 'other-observed-sense', meaning: '另一语境的含义' }));
  const record = (await repo.getPoint(id)).record;
  assert.equal(record.meaning, rich.meaning); assert.equal(record.additional_senses.length, 1);
  assert.equal(record.encounter_count, 3); assert.equal((await repo.query()).records.length, 1);
});

dbtest('legacy incomplete same-sense content is filled while originals and translations remain intact', async t => {
  const { repo, pool, save } = await fixture(t); const id = (await repo.save('legacy-incomplete', [rich])).results[0].id;
  await repo.update(id, { explanation: null, examples: [{ text: 'Original.', translation: 'Keep my translation.' }] });
  await save(); await runEnrichmentOnce(pool, async () => content);
  const record = (await repo.getPoint(id)).record;
  assert.equal(record.content_ready, true); assert.equal(record.examples[0].translation, 'Keep my translation.');
});

dbtest('nonword identity remains consistent through observe, enrichment and legacy rich save', async t => {
  const { repo, pool, save } = await fixture(t); const input = { ...raw, kind: 'expression', title: 'hold a grudge' };
  const id = (await save(undefined, input)).results[0].id;
  await runEnrichmentOnce(pool, async () => ({ ...content, sense_key: 'resentment' }));
  assert.equal((await save(undefined, input)).results[0].id, id);
  assert.equal((await repo.save('rich-after-minimal', [{ ...input, ...content, sense_key: 'resentment' }])).results[0].id, id);
});

dbtest('one tenant with a blocked point cannot starve another tenant', async t => {
  const { repo, pool, save, principal } = await fixture(t);
  await save(); const first = await claimEnrichment(pool); await save();
  const other = new Repository(pool, { ...principal, subject: 'bob' });
  await other.observe('other-tenant-observation', [raw]);
  const next = await claimEnrichment(pool); assert.ok(next); assert.equal(next.tenant_id, other.tenantId);
  await completeEnrichment(next, content); await completeEnrichment(first, content);
});

test('OpenAI provider needs server-side key and model and requests strict output with store=false', async () => {
  assert.equal(createOpenAIEnricher(), null); assert.equal(createOpenAIEnricher({ apiKey: 'test-only' }), null);
  let request;
  const provider = createOpenAIEnricher({ apiKey: 'test-only', model: 'test-model', fetchImpl: async (url, init) => {
    request = { url, ...init, body: JSON.parse(init.body) };
    return { ok: true, json: async () => ({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(content) }] }] }) };
  } });
  assert.deepEqual(await provider({ target: raw }), content); assert.equal(request.body.store, false);
  assert.equal(request.url, 'https://api.openai.com/v1/responses'); assert.equal(request.body.text.format.strict, true);
  for (const body of [{ status: 'incomplete', output: [] }, { status: 'completed', output: [{ type: 'message', content: [{ type: 'refusal' }] }] }]) {
    const bad = createOpenAIEnricher({ apiKey: 'test-only', model: 'test-model', fetchImpl: async () => ({ ok: true, json: async () => body }) });
    await assert.rejects(bad({ target: raw }));
  }
});
