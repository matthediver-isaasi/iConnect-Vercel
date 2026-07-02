-- Add app_tenant_id column to xero_token table for multi-tenant support
-- This column stores the platform tenant ID (from tenant table) to scope Xero connections per tenant

DO $$
BEGIN
    -- Add app_tenant_id column if it doesn't exist
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'xero_token' AND column_name = 'app_tenant_id'
    ) THEN
        ALTER TABLE xero_token ADD COLUMN app_tenant_id UUID;
        
        -- Create index for efficient lookups by app_tenant_id
        CREATE INDEX IF NOT EXISTS idx_xero_token_app_tenant_id ON xero_token(app_tenant_id);
    END IF;

    -- Add tenant_name column if it doesn't exist (stores the Xero organization name)
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'xero_token' AND column_name = 'tenant_name'
    ) THEN
        ALTER TABLE xero_token ADD COLUMN tenant_name VARCHAR(255);
    END IF;
END $$;
