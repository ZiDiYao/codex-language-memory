-- PostgreSQL schema shared with Python Alembic revision 0001_remote_storage.
-- Initial creation only; migration.js validates the existing revision first.
CREATE TABLE lm_tenants (
  id VARCHAR(64) PRIMARY KEY, issuer TEXT NOT NULL, subject TEXT NOT NULL,
  settings JSONB NOT NULL, content_version INTEGER NOT NULL,
  preferences_version INTEGER NOT NULL
);
CREATE TABLE lm_points (
  id SERIAL PRIMARY KEY, tenant_id VARCHAR(64) NOT NULL REFERENCES lm_tenants(id) ON DELETE CASCADE,
  identity_key VARCHAR(64) NOT NULL, kind VARCHAR(12) NOT NULL, language VARCHAR(35) NOT NULL,
  title VARCHAR(350) NOT NULL, title_key TEXT NOT NULL, sense_key TEXT NOT NULL,
  meaning TEXT NOT NULL, context TEXT, corrected_sentence TEXT, explanation TEXT,
  examples JSONB NOT NULL, additional_senses JSONB NOT NULL, note TEXT,
  search_text TEXT NOT NULL, scenes_custom BOOLEAN NOT NULL,
  created_at TIMESTAMPTZ NOT NULL, last_seen_at TIMESTAMPTZ NOT NULL,
  encounter_count INTEGER NOT NULL, repeat_priority INTEGER NOT NULL, status VARCHAR(12) NOT NULL,
  last_reviewed_at TIMESTAMPTZ, last_review_result VARCHAR(12),
  CONSTRAINT uq_lm_point_tenant_id UNIQUE (tenant_id, id),
  CONSTRAINT uq_lm_point_identity UNIQUE (tenant_id, identity_key),
  CONSTRAINT ck_lm_point_kind CHECK (kind IN ('word','expression','grammar','correction')),
  CONSTRAINT ck_lm_point_status CHECK (status IN ('new','mastered'))
);
CREATE INDEX ix_lm_point_tenant_recent ON lm_points (tenant_id, last_seen_at, id);
CREATE INDEX ix_lm_point_tenant_scope ON lm_points (tenant_id, language, kind);
CREATE TABLE lm_scenes (
  tenant_id VARCHAR(64) NOT NULL REFERENCES lm_tenants(id) ON DELETE CASCADE,
  key TEXT NOT NULL, name VARCHAR(80) NOT NULL, PRIMARY KEY (tenant_id, key)
);
CREATE TABLE lm_point_scenes (
  tenant_id VARCHAR(64) NOT NULL, point_id INTEGER NOT NULL, scene_key TEXT NOT NULL,
  position INTEGER NOT NULL, PRIMARY KEY (tenant_id, point_id, scene_key),
  FOREIGN KEY (tenant_id, point_id) REFERENCES lm_points(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, scene_key) REFERENCES lm_scenes(tenant_id, key) ON DELETE CASCADE
);
CREATE INDEX ix_lm_point_scene_filter ON lm_point_scenes (tenant_id, scene_key, point_id);
CREATE TABLE lm_save_requests (
  tenant_id VARCHAR(64) NOT NULL REFERENCES lm_tenants(id) ON DELETE CASCADE,
  request_id VARCHAR(100) NOT NULL, fingerprint VARCHAR(64) NOT NULL,
  results JSONB NOT NULL, PRIMARY KEY (tenant_id, request_id)
);
CREATE TABLE lm_encounters (
  id SERIAL PRIMARY KEY, tenant_id VARCHAR(64) NOT NULL, point_id INTEGER NOT NULL,
  request_id VARCHAR(100) NOT NULL, occurred_at TIMESTAMPTZ NOT NULL, context TEXT,
  source VARCHAR(12) NOT NULL,
  FOREIGN KEY (tenant_id, point_id) REFERENCES lm_points(tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT uq_lm_encounter_request UNIQUE (tenant_id, point_id, request_id)
);
CREATE INDEX ix_lm_encounter_point ON lm_encounters (tenant_id, point_id, id);
CREATE TABLE lm_memory_states (
  tenant_id VARCHAR(64) NOT NULL, point_id INTEGER NOT NULL, card TEXT NOT NULL,
  due_at TIMESTAMPTZ NOT NULL, rated_reviews INTEGER NOT NULL, algorithm JSONB NOT NULL,
  PRIMARY KEY (tenant_id, point_id),
  FOREIGN KEY (tenant_id, point_id) REFERENCES lm_points(tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX ix_lm_memory_due ON lm_memory_states (tenant_id, due_at);
CREATE TABLE lm_review_events (
  id SERIAL PRIMARY KEY, tenant_id VARCHAR(64) NOT NULL, point_id INTEGER NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL, result VARCHAR(12) NOT NULL, assisted BOOLEAN NOT NULL,
  effort VARCHAR(12) NOT NULL, prompt TEXT, answer TEXT, rating INTEGER,
  predicted_recall DOUBLE PRECISION, fsrs_log TEXT, algorithm JSONB,
  FOREIGN KEY (tenant_id, point_id) REFERENCES lm_points(tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX ix_lm_review_point ON lm_review_events (tenant_id, point_id, id);
CREATE TABLE lm_review_requests (
  tenant_id VARCHAR(64) NOT NULL REFERENCES lm_tenants(id) ON DELETE CASCADE,
  request_id VARCHAR(100) NOT NULL, fingerprint VARCHAR(64) NOT NULL,
  result JSONB NOT NULL, PRIMARY KEY (tenant_id, request_id)
);
CREATE TABLE alembic_version (
  version_num VARCHAR(32) NOT NULL, CONSTRAINT alembic_version_pkc PRIMARY KEY (version_num)
);
INSERT INTO alembic_version(version_num) VALUES ('0001_remote_storage');
