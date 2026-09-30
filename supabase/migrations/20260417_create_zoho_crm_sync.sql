-- Zoho CRM Sync Pipeline: per-tenant, per-entity field mapping configuration
-- and a sync log to record every push attempt to Zoho CRM.

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

-- Track Zoho CRM record id on each member and organization so subsequent
-- syncs become updates rather than creating duplicates.
ALTER TABLE member
  ADD COLUMN IF NOT EXISTS zoho_crm_id TEXT;
ALTER TABLE member
  ADD COLUMN IF NOT EXISTS zoho_crm_module TEXT;

ALTER TABLE organization
  ADD COLUMN IF NOT EXISTS zoho_crm_id TEXT;
ALTER TABLE organization
  ADD COLUMN IF NOT EXISTS zoho_crm_module TEXT;

COMMENT ON TABLE zoho_crm_sync_mapping IS 'Per-tenant Zoho CRM sync configuration for member and organization entities.';
COMMENT ON TABLE zoho_crm_sync_log IS 'Audit log of every sync attempt to Zoho CRM, including failures and the payload sent.';
COMMENT ON COLUMN zoho_crm_sync_mapping.field_mappings IS 'Array of {iconnect_field, iconnect_field_type, zoho_field, zoho_field_label} entries.';
