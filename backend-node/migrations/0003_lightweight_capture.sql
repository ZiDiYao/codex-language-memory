-- Additive Node extension: durable work survives process restarts and deployments.
CREATE TABLE lm_enrichment_jobs (
  id SERIAL PRIMARY KEY,
  tenant_id VARCHAR(64) NOT NULL,
  point_id INTEGER NOT NULL,
  request_id VARCHAR(100) NOT NULL,
  input JSONB NOT NULL,
  state VARCHAR(12) NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','processing','failed','ready')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  lease_token UUID,
  lease_until TIMESTAMPTZ,
  last_error VARCHAR(40),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (tenant_id, point_id) REFERENCES lm_points(tenant_id, id) ON DELETE CASCADE,
  UNIQUE (tenant_id, point_id, request_id)
);
CREATE INDEX ix_lm_enrichment_pending ON lm_enrichment_jobs (state, next_attempt_at, id);
CREATE INDEX ix_lm_enrichment_point ON lm_enrichment_jobs (tenant_id, point_id, id);
UPDATE lm_node_migrations SET revision='0003_lightweight_capture' WHERE revision='0002_desktop_imports';
