-- Node-owned additive extension. The shared Python base Alembic head stays
-- 0001_remote_storage, so retained Python CRUD continues to use the same data.
CREATE TABLE lm_node_migrations (
  revision VARCHAR(64) PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE lm_desktop_imports (
  tenant_id VARCHAR(64) NOT NULL REFERENCES lm_tenants(id) ON DELETE CASCADE,
  source_id UUID NOT NULL,
  payload_sha VARCHAR(64) NOT NULL,
  schema_version INTEGER NOT NULL CHECK (schema_version = 1),
  snapshot JSONB NOT NULL,
  result JSONB NOT NULL,
  imported_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (tenant_id, source_id)
);
INSERT INTO lm_node_migrations(revision) VALUES ('0002_desktop_imports');
