import { databaseUrl, supabase } from '../_lib/database.js';
import { getTenantContext, hasAdminAccess } from '../_lib/tenantContext.js';
import pg from 'pg';

// Kept in sync with supabase/migrations/20260417_create_zoho_crm_sync.sql.
// Inlined so the endpoint works even if the migrations directory is not
// shipped with the deployed serverless bundle.
const SYNC_SQL = `
CREATE TABLE IF NOT EXISTS zoho_crm_sync_mapping (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  entity_type TEXT NOT NULL CHECK (entity_type IN ('member', 'organization')),
  zoho_module TEXT NOT NULL,
  unique_key_field TEXT NOT NULL,
  is_enabled BOOLEAN NOT NULL DEFAULT false,
  field_mappings JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, entity_type)
);

CREATE INDEX IF NOT EXISTS idx_zoho_crm_sync_mapping_tenant
  ON zoho_crm_sync_mapping(tenant_id);

CREATE TABLE IF NOT EXISTS zoho_crm_sync_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  entity_type TEXT NOT NULL,
  entity_id UUID,
  zoho_module TEXT,
  zoho_record_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('success', 'failed', 'skipped', 'pending')),
  action TEXT,
  error_message TEXT,
  request_payload JSONB,
  response_payload JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_zoho_crm_sync_log_tenant_created
  ON zoho_crm_sync_log(tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_zoho_crm_sync_log_entity
  ON zoho_crm_sync_log(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_zoho_crm_sync_log_status
  ON zoho_crm_sync_log(tenant_id, status, created_at DESC);

ALTER TABLE member ADD COLUMN IF NOT EXISTS zoho_crm_id TEXT;
ALTER TABLE member ADD COLUMN IF NOT EXISTS zoho_crm_module TEXT;
ALTER TABLE organization ADD COLUMN IF NOT EXISTS zoho_crm_id TEXT;
ALTER TABLE organization ADD COLUMN IF NOT EXISTS zoho_crm_module TEXT;

-- Reverse sync (Zoho CRM → iConnect) additions.
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
ALTER TABLE zoho_crm_sync_mapping
  ADD COLUMN IF NOT EXISTS deletion_policy TEXT NOT NULL DEFAULT 'ignore'
    CHECK (deletion_policy IN ('ignore', 'unlink', 'delete'));

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
ALTER TABLE zoho_crm_sync_log ADD COLUMN IF NOT EXISTS source TEXT;
ALTER TABLE zoho_crm_sync_log ADD COLUMN IF NOT EXISTS payload_hash TEXT;
ALTER TABLE zoho_crm_sync_log ADD COLUMN IF NOT EXISTS conflict_resolution TEXT;
CREATE INDEX IF NOT EXISTS idx_zoho_crm_sync_log_direction
  ON zoho_crm_sync_log(tenant_id, direction, created_at DESC);

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
`;

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  try {
    const ctx = await getTenantContext(req);
    if (!ctx?.tenantId) return res.status(401).json({ error: 'Unauthorized' });
    if (!(await hasAdminAccess(ctx))) {
      return res.status(403).json({ error: 'Admin access required' });
    }

    if (!databaseUrl) {
      return res.status(500).json({ error: 'DATABASE_URL not configured', sql: SYNC_SQL });
    }
    const client = new pg.Client({ connectionString: databaseUrl, ssl: { rejectUnauthorized: false } });
    await client.connect();
    try {
      await client.query(SYNC_SQL);
    } finally {
      await client.end();
    }
    if (supabase) {
      try { await supabase.rpc('exec_sql', { sql_text: "NOTIFY pgrst, 'reload schema';" }); } catch {}
    }
    return res.status(200).json({ success: true, message: 'Zoho CRM sync tables created' });
  } catch (err) {
    console.error('[InitZohoCrmSyncTables] Error:', err);
    return res.status(500).json({ error: err.message, sql: SYNC_SQL });
  }
}
