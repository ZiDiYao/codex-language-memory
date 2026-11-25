-- UI receipts are separate from actual word/expression encounters. Never
-- backfill clicks or turn page interactions into fabricated learning history.
CREATE TABLE lm_activity_events (
  tenant_id VARCHAR(64) NOT NULL REFERENCES lm_tenants(id) ON DELETE CASCADE,
  event_id UUID NOT NULL,
  kind VARCHAR(16) NOT NULL CHECK (kind IN ('button','pronunciation')),
  occurred_at TIMESTAMPTZ NOT NULL,
  received_at TIMESTAMPTZ NOT NULL,
  occurred_bucket BIGINT NOT NULL,
  PRIMARY KEY (tenant_id, event_id),
  UNIQUE (tenant_id, kind, occurred_bucket)
);
CREATE INDEX ix_lm_activity_date ON lm_activity_events (tenant_id, occurred_at);
CREATE INDEX ix_lm_activity_received ON lm_activity_events (tenant_id, received_at);
CREATE INDEX ix_lm_encounter_date ON lm_encounters (tenant_id, occurred_at);
UPDATE lm_node_migrations SET revision='0004_activity_events' WHERE revision='0003_lightweight_capture';
