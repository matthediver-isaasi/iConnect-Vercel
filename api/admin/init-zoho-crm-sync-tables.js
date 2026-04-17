import { databaseUrl, supabase } from '../_lib/database.js';
import { getTenantContext } from '../_lib/tenantContext.js';
import pg from 'pg';

const SYNC_SQL = `
CREATE TABLE IF NOT EXISTS zoho_crm_sync_mapping (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
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
  tenant_id UUID NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id UUID,
  zoho_module TEXT,
  zoho_record_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('success', 'failed', 'skipped')),
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
`;

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  try {
    const ctx = await getTenantContext(req);
    if (!ctx?.tenantId) return res.status(401).json({ error: 'Unauthorized' });

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
