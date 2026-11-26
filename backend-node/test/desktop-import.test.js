import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createPool, checkSchema } from '../src/database.js';
import { migrate } from '../src/migration.js';
import { Repository } from '../src/repository.js';
import { DESKTOP_TABLES, validateDesktopSnapshot } from '../src/desktop-import.js';
import { normalized } from '../src/parity.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
const clone = value => structuredClone(value);
const emptySnapshot = () => ({ schema_version: 1, source_id: randomUUID(), tables: Object.fromEntries(DESKTOP_TABLES.map(name => [name, []])) });
const principal = subject => ({ issuer: 'https://desktop-import-tests.example/', subject });
const captured = { kind: 'word', language: 'en', title: 'rinse', sense_key: 'wash with water', meaning: 'Wash with water.',
  explanation: 'Rinse removes soap or dirt with clean water.', examples: [{ text: 'Rinse the cup.' }, { text: 'Rinse your hands.' }], scenes: ['Cleaning'] };

function pythonSnapshot() {
  const source = String.raw`
import json, tempfile, uuid
from pathlib import Path
from store import Store, Patch, Review, SettingsPatch, LearnerPreferences, now
from study import StudySessions
point = {'kind':'word','language':'en','title':'rinse','sense_key':'wash with water','meaning':'Wash with water.',
         'explanation':'Rinse removes soap or dirt with clean water.', 'examples':[{'text':'Rinse the cup.'},{'text':'Rinse your hands.'}],
         'scenes':['Cleaning']}
tables = ['knowledge','settings','capture_preferences','encounters','review_events','memory_states',
          'learner_preferences','export_receipts','study_sessions','study_items','study_answers']
with tempfile.TemporaryDirectory() as directory:
    store = Store(Path(directory)/'fixture.sqlite3')
    first = store.save('fixture-capture-one',[point])['results'][0]['id']
    store.save('fixture-capture-two',[dict(point,sense_key='rinse away',meaning='Remove soap with water.')])
    store.save('fixture-expression',[dict(point,kind='expression',title='turn off',sense_key='device off',meaning='Stop an electrical device.')])
    store.update(first,Patch(note='',scenes=['At home','Cleaning']))
    store.record_review(first,'fixture-review-one',Review(result='correct',answer='Wash with water.'))
    study=StudySessions(store)
    session=study.start('fixture-study-round',language='en',limit=1,include_upcoming=True)['session']
    current=session['current']['record']
    session=study.prepare(session['id'],session['version'],current['id'],current['revision'],'Use this expression.')['session']
    study.answer(session['id'],session['version'],'fixture-study-answer',Review(result='correct',assisted=True,answer='Turn off the light.'))
    store.settings(SettingsPatch(ui_language='zh',first_language='zh',explanation_language='zh',enabled=False,english_learning_instructions='Use kitchen examples.'))
    store.learning_preferences('en',LearnerPreferences(learning_goal='Everyday conversation',interests=['Cooking']))
    store.export_receipt('fixture-export',{'format':'json','count':2,'exported_at':now()})
    with store.connection() as db:
        snapshot={name:[dict(row) for row in db.execute('SELECT * FROM '+name)] for name in tables}
    print(json.dumps({'schema_version':1,'source_id':str(uuid.uuid4()),'tables':snapshot},ensure_ascii=False,allow_nan=False))
`;
  const child = spawnSync(process.env.PYTHON_EXECUTABLE, ['-c', source], { cwd: root, encoding: 'utf8', timeout: 30000 });
  assert.equal(child.status, 0, 'isolated Python Store/Study fixture generation failed');
  return JSON.parse(child.stdout);
}

test('desktop snapshot is a closed table/column allowlist with bounded scalar data', () => {
  const source = emptySnapshot();
  assert.equal(validateDesktopSnapshot(source).sourceId, source.source_id);
  for (const mutate of [s => { s.user_id = 'another-user'; }, s => { s.tables.oauth_tokens = []; },
    s => { s.tables.settings = [{ id: 1, recording: 1, access_token: 'not-accepted' }]; },
    s => { s.tables.capture_preferences = [{ id: 1, data: '{"refresh_token":"not-accepted"}' }]; },
    s => { s.tables.capture_preferences = [{ id: 1, data: '{"ui_language":"\u0000"}' }]; },
    s => { s.tables.study_answers = [{ request_id: 'answer', fingerprint: 'a'.repeat(64), session_id: 'missing', applied_version: 1 }]; },
    s => { s.source_id = '../../settings'; }, s => { s.schema_version = 2; },
    s => { s.tables.settings = [{ id: 1, recording: true }]; }, s => { s.padding = 'x'.repeat(8 * 1024 * 1024); }]) {
    const candidate = clone(source); mutate(candidate);
    assert.throws(() => validateDesktopSnapshot(candidate), error => error.code === 'invalid_request');
  }
});

describe('PostgreSQL desktop import preserves actual Python learning snapshots', {
  skip: !(process.env.TEST_DATABASE_URL && process.env.PYTHON_EXECUTABLE), concurrency: false,
}, () => {
  let admin, pool, snapshot;
  const schema = 'desktop_import_' + randomUUID().replaceAll('-', '');
  const repo = subject => new Repository(pool, principal(subject));
  before(async () => {
    snapshot = pythonSnapshot();
    admin = createPool(process.env.TEST_DATABASE_URL);
    await admin.query(`CREATE SCHEMA ${schema}`);
    pool = createPool(process.env.TEST_DATABASE_URL, { options: `-c search_path=${schema}` });
    await migrate(pool);
  });
  after(async () => {
    await pool?.end();
    if (admin) { await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await admin.end(); }
  });

  test('raw SQLite shapes, null/empty notes, scenes, senses, FSRS and archived study data survive without new encounters', async () => {
    const repository = repo('raw-fidelity');
    await repo('sequence-offset').save('sequence-offset-save', [captured]);
    const source = clone(snapshot), before = JSON.stringify(source);
    const first = await repository.import_desktop(source);
    assert.equal(JSON.stringify(source), before, 'validation must not change the archived raw TEXT JSON');
    assert.equal(first.status, 'imported');
    assert.equal(first.source_id, source.source_id);
    assert.match(first.payload_sha, /^[a-f0-9]{64}$/);
    assert.equal(first.counts.points_inserted, source.tables.knowledge.length);
    assert.equal(first.counts.encounters_inserted, source.tables.encounters.length);
    assert.equal(first.counts.reviews_inserted, source.tables.review_events.length);
    const live = (await repository.query({ include_variants: true })).records;
    for (const raw of source.tables.knowledge) {
      const point = live.find(item => item.id === first.point_id_map[raw.id]);
      assert.equal(point.encounter_count, raw.encounter_count);
      assert.equal(point.repeat_priority, raw.repeat_priority);
      assert.equal(point.note_is_custom, raw.note !== null);
      assert.equal(point.note, raw.note === null ? point.note : raw.note);
      assert.deepEqual(point.additional_senses, JSON.parse(raw.additional_senses));
      assert.deepEqual(point.scenes, JSON.parse(raw.scenes));
      const stored = (await pool.query('SELECT note,scenes_custom FROM lm_points WHERE tenant_id=$1 AND id=$2', [repository.tenantId, point.id])).rows[0];
      assert.equal(stored.note, raw.note); assert.equal(stored.scenes_custom, Boolean(raw.scenes_custom));
    }
    const rawMemory = source.tables.memory_states[0];
    const memory = (await pool.query('SELECT * FROM lm_memory_states WHERE tenant_id=$1', [repository.tenantId])).rows[0];
    assert.equal(memory.point_id, first.point_id_map[rawMemory.record_id]);
    const expectedCard = { ...JSON.parse(rawMemory.card), card_id: memory.point_id };
    assert.deepEqual(JSON.parse(memory.card), expectedCard);
    assert.notEqual(memory.point_id, rawMemory.record_id, 'fixture must exercise old-to-cloud ID remapping');
    assert.equal(memory.rated_reviews, rawMemory.rated_reviews);
    assert.equal((await repository.settings()).enabled, false, 'capture pause does not block an evidence import');
    assert.equal((await repository.settings()).first_language, 'zh');
    assert.equal((await repository.settings()).english_learning_instructions, 'Use kitchen examples.');
    const archive = (await pool.query('SELECT snapshot,result FROM lm_desktop_imports WHERE tenant_id=$1 AND source_id=$2', [repository.tenantId, source.source_id])).rows[0];
    assert.deepEqual(archive.snapshot, source);
    assert.equal(typeof archive.snapshot.tables.memory_states[0].card, 'string');
    const versions = await repository.versions();
    const replays = await Promise.all([repository.import_desktop(source), repository.import_desktop(source)]);
    assert.ok(replays.every(result => result.status === 'already_imported'));
    assert.deepEqual(await repository.versions(), versions);
    assert.equal(Number((await pool.query('SELECT count(*) FROM lm_encounters WHERE tenant_id=$1', [repository.tenantId])).rows[0].count), source.tables.encounters.length);
    const changed = clone(source); changed.tables.knowledge[0].note = 'changed after capture';
    assert.equal((await repository.import_desktop(changed)).error, 'import_source_conflict');
    assert.deepEqual((await pool.query('SELECT snapshot FROM lm_desktop_imports WHERE tenant_id=$1', [repository.tenantId])).rows[0].snapshot, source);
  });

  test('cloud edits, manual scenes, settings and memory win collisions; original local metadata stays archived', async () => {
    const repository = repo('collision');
    const id = (await repository.save('collision-capture', [captured])).results[0].id;
    await repository.update(id, { note: 'Existing cloud edit', scenes: ['Cloud scene'], status: 'mastered' });
    await repository.settings({ first_language: 'ja' });
    await repository.record_review(id, 'collision-review', { result: 'correct', answer: 'Cloud answer' });
    const card = (await pool.query('SELECT card FROM lm_memory_states WHERE tenant_id=$1 AND point_id=$2', [repository.tenantId, id])).rows[0].card;
    const source = clone(snapshot); source.source_id = randomUUID();
    const result = await repository.import_desktop(source);
    const current = (await repository.get_point(id)).record;
    assert.equal(current.note, 'Existing cloud edit'); assert.deepEqual(current.scenes, ['Cloud scene']); assert.equal(current.status, 'mastered');
    assert.equal((await repository.settings()).first_language, 'ja');
    assert.equal(result.counts.settings_imported, 0);
    assert.equal((await pool.query('SELECT card FROM lm_memory_states WHERE tenant_id=$1 AND point_id=$2', [repository.tenantId, id])).rows[0].card, card);
    assert.ok(result.conflicts.some(item => item.cloud_id === id && item.kind === 'cloud_memory_preserved'));
    assert.equal(current.encounter_count, 3, 'only historical encounters are added, never a new import encounter');
    assert.deepEqual((await pool.query('SELECT snapshot FROM lm_desktop_imports WHERE tenant_id=$1', [repository.tenantId])).rows[0].snapshot, source);
    const second = clone(source); second.source_id = randomUUID();
    const repeatedHistory = await repository.import_desktop(second);
    assert.equal(repeatedHistory.counts.encounters_inserted, 0);
    assert.equal(repeatedHistory.counts.reviews_inserted, 0);
    assert.equal((await repository.get_point(id)).record.encounter_count, 3);
  });

  test('concurrent receipts commit once and identical source UUIDs remain isolated between verified tenants', async () => {
    const repository = repo('concurrent');
    const source = clone(snapshot); source.source_id = randomUUID();
    const results = await Promise.all(Array.from({ length: 3 }, () => repository.import_desktop(source)));
    assert.equal(results.filter(item => item.status === 'imported').length, 1);
    assert.equal(results.filter(item => item.status === 'already_imported').length, 2);
    const other = repo('other-tenant');
    assert.deepEqual((await other.query()).records, []);
    const imported = await other.import_desktop(source);
    assert.equal(imported.status, 'imported');
    assert.notEqual(imported.point_id_map[1], results[0].point_id_map[1]);
    assert.equal(Number((await pool.query('SELECT count(*) FROM lm_desktop_imports WHERE source_id=$1', [source.source_id])).rows[0].count), 2);
  });

  test('duplicate legacy identities never double-count imported encounters and unsupported memory remains archived', async () => {
    const source = clone(snapshot); source.source_id = randomUUID();
    const duplicate = { ...clone(source.tables.knowledge[0]), id: 99, sense_key: 'legacy extra sense', encounter_count: 7 };
    source.tables.knowledge.push(duplicate);
    source.tables.encounters.push({ ...clone(source.tables.encounters[0]), id: 99, record_id: 99, context: 'Legacy context for the same capture' });
    const repository = repo('legacy-duplicates');
    const result = await repository.import_desktop(source);
    assert.equal(result.point_id_map[duplicate.id], result.point_id_map[source.tables.knowledge[0].id]);
    assert.equal((await repository.get_point(result.point_id_map[duplicate.id])).record.encounter_count, 7);
    assert.equal(result.counts.encounters_inserted, source.tables.encounters.length - 1);
    assert.equal(result.counts.encounters_deduplicated, 1);
    assert.equal(result.counts.points_inserted, 2);
    assert.equal(result.counts.points_existing, 1);
    const unsupported = clone(snapshot); unsupported.source_id = randomUUID();
    unsupported.tables.memory_states[0].algorithm = JSON.stringify({ name: 'Unrecognized future scheduler' });
    const other = repo('future-memory');
    const archived = await other.import_desktop(unsupported);
    assert.equal(archived.counts.memory_states_inserted, 0);
    assert.equal(archived.counts.memory_states_archived, 1);
    assert.equal(Number((await pool.query('SELECT count(*) FROM lm_memory_states WHERE tenant_id=$1', [other.tenantId])).rows[0].count), 0);
    assert.deepEqual((await pool.query('SELECT snapshot FROM lm_desktop_imports WHERE tenant_id=$1', [other.tenantId])).rows[0].snapshot, unsupported);
  });

  test('invalid references fail before writes and SQL failure rolls the entire archive/evidence transaction back', async () => {
    const repository = repo('atomic');
    const invalid = clone(snapshot); invalid.tables.encounters[0].record_id = 99999;
    await assert.rejects(repository.import_desktop(invalid), error => error.code === 'invalid_request');
    await pool.query(`CREATE FUNCTION reject_desktop_fixture() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.title='IMPORT_FAIL_FIXTURE' THEN RAISE EXCEPTION 'fixture_failure'; END IF; RETURN NEW; END; $$;
      CREATE TRIGGER reject_desktop_fixture BEFORE INSERT ON lm_points FOR EACH ROW EXECUTE FUNCTION reject_desktop_fixture()`);
    try {
      const source = clone(snapshot); source.source_id = randomUUID();
      source.tables.knowledge[1].title = 'IMPORT_FAIL_FIXTURE'; source.tables.knowledge[1].title_key = normalized('IMPORT_FAIL_FIXTURE');
      await assert.rejects(repository.import_desktop(source));
    } finally { await pool.query('DROP TRIGGER reject_desktop_fixture ON lm_points; DROP FUNCTION reject_desktop_fixture()'); }
    for (const table of ['lm_points', 'lm_encounters', 'lm_review_events', 'lm_memory_states', 'lm_desktop_imports'])
      assert.equal(Number((await pool.query(`SELECT count(*) FROM ${table} WHERE tenant_id=$1`, [repository.tenantId])).rows[0].count), 0);
  });

  test('existing base databases upgrade additively; unknown extension revisions fail closed', async t => {
    const name = 'desktop_upgrade_' + randomUUID().replaceAll('-', '');
    await admin.query(`CREATE SCHEMA ${name}`);
    const base = createPool(process.env.TEST_DATABASE_URL, { options: `-c search_path=${name}` });
    t.after(async () => { await base.end(); await admin.query(`DROP SCHEMA ${name} CASCADE`); });
    await migrate(base, { baseOnly: true });
    const repository = new Repository(base, principal('before-upgrade'));
    const saved = await repository.save('before-upgrade-capture', [captured]);
    assert.equal((await migrate(base)).status, 'migrated');
    assert.equal(await checkSchema(base), true);
    assert.equal((await repository.get_point(saved.results[0].id)).status, 'found');
    assert.equal((await base.query('SELECT version_num FROM alembic_version')).rows[0].version_num, '0001_remote_storage');
    await base.query("UPDATE lm_node_migrations SET revision='unknown_future'");
    await assert.rejects(migrate(base), /Unsupported Node extension/);
    assert.equal((await repository.get_point(saved.results[0].id)).status, 'found');
  });
});
