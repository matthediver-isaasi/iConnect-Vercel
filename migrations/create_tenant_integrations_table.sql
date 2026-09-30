-- Create tenant_integrations table for storing per-tenant integration credentials
-- Credentials are stored encrypted and should be handled securely

CREATE TABLE IF NOT EXISTS tenant_integrations (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  integration_type VARCHAR(50) NOT NULL,
  credentials JSONB NOT NULL DEFAULT '{}',
  is_enabled BOOLEAN DEFAULT false,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE(tenant_id, integration_type)
);

-- Create index for faster lookups
CREATE INDEX IF NOT EXISTS idx_tenant_integrations_tenant_id ON tenant_integrations(tenant_id);
CREATE INDEX IF NOT EXISTS idx_tenant_integrations_type ON tenant_integrations(integration_type);

-- Add RLS policies
ALTER TABLE tenant_integrations ENABLE ROW LEVEL SECURITY;

-- Policy to allow tenants to read/write their own integrations
CREATE POLICY tenant_integrations_policy ON tenant_integrations
  FOR ALL
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

-- Comment on table
COMMENT ON TABLE tenant_integrations IS 'Stores per-tenant integration credentials (Zoom, etc.)';
COMMENT ON COLUMN tenant_integrations.credentials IS 'Encrypted JSONB containing integration-specific credentials';
