-- Zoho CRM reverse sync: schema additions for inbound (Zoho → iConnect) flow,
-- loop prevention via payload hashes, conflict policy, and reconciliation cursor.

ALTER TABLE zoho_crm_sync_mapping
  ADD COLUMN IF NOT EXISTS sync_direction TEXT NOT NULL DEFAULT 'outbound'
    CHECK (sync_direction IN ('outbound', 'inbound', 'bidirectional'));

ALTER TABLE zoho_crm_sync_mapping
  ADD COLUMN IF NOT EXISTS conflict_policy TEXT NOT NULL DEFAULT 'last_write_wins'
    CHECK (conflict_policy IN ('last_write_wins', 'zoho_wins', 'iconnect_wins'));

ALTER TABLE zoho_crm_sync_mapping
  ADD COLUMN IF NOT EXISTS last_inbound_cursor TIMESTAMPTZ;

ALTER TABLE zoho_crm_sync_mapping
  ADD COLUMN IF NOT EXISTS unmatched_policy TEXT NOT NULL DEFAULT 'ignore'
    CHECK (unmatched_policy IN ('ignore', 'create', 'queue'));

-- Allow 'pending' status for queued unmatched inbound records.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.constraint_column_usage
    WHERE table_name = 'zoho_crm_sync_log' AND constraint_name = 'zoho_crm_sync_log_status_check'
  ) THEN
    ALTER TABLE zoho_crm_sync_log DROP CONSTRAINT zoho_crm_sync_log_status_check;
  END IF;
END $$;
ALTER TABLE zoho_crm_sync_log
  ADD CONSTRAINT zoho_crm_sync_log_status_check
  CHECK (status IN ('success', 'failed', 'skipped', 'pending'));

ALTER TABLE zoho_crm_sync_log
  ADD COLUMN IF NOT EXISTS direction TEXT NOT NULL DEFAULT 'outbound'
    CHECK (direction IN ('outbound', 'inbound'));

ALTER TABLE zoho_crm_sync_log
  ADD COLUMN IF NOT EXISTS source TEXT;

ALTER TABLE zoho_crm_sync_log
  ADD COLUMN IF NOT EXISTS payload_hash TEXT;

ALTER TABLE zoho_crm_sync_log
  ADD COLUMN IF NOT EXISTS conflict_resolution TEXT;

CREATE INDEX IF NOT EXISTS idx_zoho_crm_sync_log_direction
  ON zoho_crm_sync_log(tenant_id, direction, created_at DESC);

-- Per (tenant, entity, direction) record of the most recent successfully synced
-- payload hash and time. Used for echo / loop prevention.
CREATE TABLE IF NOT EXISTS zoho_crm_sync_state (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  entity_type TEXT NOT NULL,
  entity_id UUID NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('outbound', 'inbound')),
  payload_hash TEXT NOT NULL,
  last_synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, entity_type, entity_id, direction)
);

CREATE INDEX IF NOT EXISTS idx_zoho_crm_sync_state_lookup
  ON zoho_crm_sync_state(tenant_id, entity_type, entity_id);

COMMENT ON COLUMN zoho_crm_sync_mapping.sync_direction IS 'outbound | inbound | bidirectional';
COMMENT ON COLUMN zoho_crm_sync_mapping.conflict_policy IS 'last_write_wins | zoho_wins | iconnect_wins';
COMMENT ON COLUMN zoho_crm_sync_mapping.last_inbound_cursor IS 'Most recent Zoho Modified_Time successfully reconciled by the poller.';
COMMENT ON TABLE zoho_crm_sync_state IS 'Tracks last synced payload hash per (entity, direction) for echo / loop prevention.';
