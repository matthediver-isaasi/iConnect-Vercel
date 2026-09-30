-- Correlate durable workflow attempts with their claim without treating action
-- logs as evidence of a completed action batch.
ALTER TABLE workflow_log ADD COLUMN IF NOT EXISTS delivery_key TEXT;
CREATE INDEX IF NOT EXISTS workflow_log_delivery_key_idx
  ON workflow_log (delivery_key) WHERE delivery_key IS NOT NULL;