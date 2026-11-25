import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createPool, SCHEMA_REVISION, NODE_SCHEMA_REVISION } from './database.js';

const tables = ['lm_tenants', 'lm_points', 'lm_scenes', 'lm_point_scenes', 'lm_save_requests',
  'lm_encounters', 'lm_memory_states', 'lm_review_events', 'lm_review_requests'];

export async function migrate(pool, { baseOnly = false } = {}) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Transaction-scoped lock shared by all Node migrators for this database.
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended('language-memory-schema', 0))");
    const versionTable = await client.query("SELECT to_regclass('alembic_version') AS name");
    let migrated = false;
    if (versionTable.rows[0].name != null) {
      const versions = await client.query('SELECT version_num FROM alembic_version');
      if (versions.rows.length !== 1 || versions.rows[0].version_num !== SCHEMA_REVISION) {
        throw new Error('Unsupported database migration revision');
      }
      for (const table of tables) {
        if ((await client.query('SELECT to_regclass($1) AS name', [table])).rows[0].name == null) {
          throw new Error('Database schema is incomplete');
        }
      }
    } else {
      // Refuse to stamp or modify an unversioned, partially populated database.
      for (const table of [...tables, 'lm_node_migrations', 'lm_desktop_imports', 'lm_enrichment_jobs', 'lm_activity_events']) {
        if ((await client.query('SELECT to_regclass($1) AS name', [table])).rows[0].name != null) {
          throw new Error('Unversioned database contains language memory tables');
        }
      }
      const sql = await readFile(new URL('../migrations/0001_remote_storage.sql', import.meta.url), 'utf8');
      await client.query(sql);
      migrated = true;
    }
    if (!baseOnly) {
      const marker = (await client.query("SELECT to_regclass('lm_node_migrations') AS name")).rows[0].name;
      if (marker == null) {
        if ((await client.query("SELECT to_regclass('lm_desktop_imports') AS name")).rows[0].name != null)
          throw new Error('Unversioned Node extension tables');
        await client.query(await readFile(new URL('../migrations/0002_desktop_imports.sql', import.meta.url), 'utf8'));
        migrated = true;
      } else {
        const revisions = (await client.query('SELECT revision FROM lm_node_migrations')).rows;
        if (revisions.length !== 1 || !['0002_desktop_imports', '0003_lightweight_capture', NODE_SCHEMA_REVISION].includes(revisions[0].revision)
            || (await client.query("SELECT to_regclass('lm_desktop_imports') AS name")).rows[0].name == null)
          throw new Error('Unsupported Node extension revision');
      }
      const head = (await client.query('SELECT revision FROM lm_node_migrations')).rows[0]?.revision;
      if (head === '0002_desktop_imports') {
        if ((await client.query("SELECT to_regclass('lm_enrichment_jobs') AS name")).rows[0].name != null)
          throw new Error('Unversioned enrichment table');
        await client.query(await readFile(new URL('../migrations/0003_lightweight_capture.sql', import.meta.url), 'utf8'));
        migrated = true;
      } else if ((await client.query("SELECT to_regclass('lm_enrichment_jobs') AS name")).rows[0].name == null) {
        throw new Error('Missing enrichment table');
      }
      const activityHead = (await client.query('SELECT revision FROM lm_node_migrations')).rows[0]?.revision;
      if (activityHead === '0003_lightweight_capture') {
        if ((await client.query("SELECT to_regclass('lm_activity_events') AS name")).rows[0].name != null)
          throw new Error('Unversioned activity table');
        await client.query(await readFile(new URL('../migrations/0004_activity_events.sql', import.meta.url), 'utf8'));
        migrated = true;
      } else if ((await client.query("SELECT to_regclass('lm_activity_events') AS name")).rows[0].name == null) {
        throw new Error('Missing activity table');
      }
    }
    await client.query('COMMIT');
    return { status: migrated ? 'migrated' : 'current', revision: SCHEMA_REVISION,
      ...(baseOnly ? {} : { node_revision: NODE_SCHEMA_REVISION }) };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  let pool;
  try {
    pool = createPool(process.env.DATABASE_URL);
    const result = await migrate(pool);
    console.log(`Database ${result.status}: ${result.revision}`);
  } catch {
    console.error('Database migration failed. Check connectivity and the current schema revision.');
    process.exitCode = 1;
  } finally {
    await pool?.end();
  }
}
