import pg from 'pg';

export const SCHEMA_REVISION = '0001_remote_storage';

// Keep PostgreSQL microseconds in cursors. The driver's default Date parser
// truncates them, which can skip points encountered in the same millisecond.
export function timestamp(value) {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString().replace(/\.(\d{3})Z$/, (_, ms) => `.${ms}000+00:00`);
  const text = String(value);
  const date = new Date(text);
  if (!Number.isFinite(date.getTime())) throw new TypeError('Invalid timestamp');
  const fraction = (text.match(/\.(\d+)/)?.[1] ?? '').padEnd(6, '0').slice(0, 6);
  return `${date.toISOString().slice(0, 19)}.${fraction}+00:00`;
}

export function createPool(url, options = {}) {
  if (typeof url !== 'string') throw new TypeError('DATABASE_URL is required');
  const connectionString = url.replace(/^postgresql\+psycopg:\/\//, 'postgresql://');
  const parsed = new URL(connectionString);
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) throw new TypeError('PostgreSQL is required');
  const types = {
    getTypeParser(oid, format) {
      if (format !== 'binary' && [1184, 1114].includes(oid)) return timestamp;
      return pg.types.getTypeParser(oid, format);
    },
  };
  const pool = new pg.Pool({ connectionString, max: 10, connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 30_000, types, ...options });
  pool.on('error', (error) => {
    // Never log database messages, SQL bind values, connection strings or notes.
    console.error('database_pool_error', { code: /^[A-Z0-9_]{1,30}$/.test(error.code ?? '') ? error.code : 'unknown' });
  });
  return pool;
}

export async function checkSchema(pool) {
  const result = await pool.query('SELECT version_num FROM alembic_version');
  return result.rows.length === 1 && result.rows[0].version_num === SCHEMA_REVISION;
}
