-- Migration: Add tenant-specific credentials table
-- This allows users to have different passwords for different tenants
-- Date: 2026-01-15

-- Create tenant_membership_credentials table for per-tenant password storage
CREATE TABLE IF NOT EXISTS tenant_membership_credentials (
    id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid()::text,
    identity_id VARCHAR NOT NULL REFERENCES tenant_identity(id) ON DELETE CASCADE,
    tenant_id UUID NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
    password_hash TEXT,
    reset_token TEXT,
    reset_token_expires TIMESTAMPTZ,
    failed_attempts INTEGER DEFAULT 0,
    locked_until TIMESTAMPTZ,
    last_login TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    
    -- Each identity can only have one credential per tenant
    UNIQUE(identity_id, tenant_id)
);

-- Index for fast lookups during login
CREATE INDEX IF NOT EXISTS idx_tenant_membership_credentials_identity_tenant 
    ON tenant_membership_credentials(identity_id, tenant_id);

-- Index for token lookups during password reset
CREATE INDEX IF NOT EXISTS idx_tenant_membership_credentials_reset_token 
    ON tenant_membership_credentials(reset_token) 
    WHERE reset_token IS NOT NULL;

-- Add RLS policies
ALTER TABLE tenant_membership_credentials ENABLE ROW LEVEL SECURITY;

-- Service role can do everything
CREATE POLICY "Service role full access" ON tenant_membership_credentials
    FOR ALL
    USING (true)
    WITH CHECK (true);

-- Add trigger to update updated_at on changes
CREATE OR REPLACE FUNCTION update_tenant_membership_credentials_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_update_tenant_membership_credentials_updated_at ON tenant_membership_credentials;
CREATE TRIGGER trigger_update_tenant_membership_credentials_updated_at
    BEFORE UPDATE ON tenant_membership_credentials
    FOR EACH ROW
    EXECUTE FUNCTION update_tenant_membership_credentials_updated_at();

-- Migration: Copy existing passwords from tenant_identity to tenant_membership_credentials
-- This creates tenant-specific credentials for existing users based on their memberships
-- Only run this once during migration
DO $$
DECLARE
    membership_record RECORD;
    identity_record RECORD;
BEGIN
    -- For each active tenant_membership, create a tenant_membership_credentials record
    -- if the identity has a password_hash
    FOR membership_record IN 
        SELECT tm.identity_id, tm.tenant_id, ti.password_hash
        FROM tenant_membership tm
        JOIN tenant_identity ti ON ti.id = tm.identity_id
        WHERE ti.password_hash IS NOT NULL
        AND tm.status = 'active'
    LOOP
        -- Insert if not exists
        INSERT INTO tenant_membership_credentials (identity_id, tenant_id, password_hash)
        VALUES (membership_record.identity_id, membership_record.tenant_id, membership_record.password_hash)
        ON CONFLICT (identity_id, tenant_id) DO NOTHING;
    END LOOP;
    
    RAISE NOTICE 'Migration complete: Created tenant-specific credentials from existing passwords';
END $$;
