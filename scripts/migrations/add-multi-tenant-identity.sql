-- Migration: Add multi-tenant identity support
-- Allows a single user (by email) to own/manage multiple tenants
-- Run this SQL in your Supabase SQL Editor

-- Step 1: Create tenant_identity table (global user identity)
CREATE TABLE IF NOT EXISTS tenant_identity (
  id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid()::text,
  email VARCHAR NOT NULL UNIQUE,
  first_name VARCHAR,
  last_name VARCHAR,
  password_hash VARCHAR,
  google_id VARCHAR,
  avatar_url VARCHAR,
  is_temporary BOOLEAN DEFAULT false,
  reset_token VARCHAR,
  reset_token_expires TIMESTAMP WITH TIME ZONE,
  last_login TIMESTAMP WITH TIME ZONE,
  failed_attempts INTEGER DEFAULT 0,
  locked_until TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Step 2: Create tenant_membership table (links identities to tenants)
-- Note: tenant_id uses UUID to match the tenant table's id column type
CREATE TABLE IF NOT EXISTS tenant_membership (
  id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid()::text,
  identity_id VARCHAR NOT NULL REFERENCES tenant_identity(id) ON DELETE CASCADE,
  tenant_id UUID NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  role VARCHAR DEFAULT 'owner',  -- owner, admin, billing, viewer
  status VARCHAR DEFAULT 'active',
  is_default BOOLEAN DEFAULT false, -- Default tenant for this user
  last_accessed TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE(identity_id, tenant_id)
);

-- Step 3: Indexes for performance
CREATE INDEX IF NOT EXISTS idx_tenant_identity_email ON tenant_identity(email);
CREATE INDEX IF NOT EXISTS idx_tenant_identity_google_id ON tenant_identity(google_id);
CREATE INDEX IF NOT EXISTS idx_tenant_membership_identity_id ON tenant_membership(identity_id);
CREATE INDEX IF NOT EXISTS idx_tenant_membership_tenant_id ON tenant_membership(tenant_id);
CREATE INDEX IF NOT EXISTS idx_tenant_membership_identity_tenant ON tenant_membership(identity_id, tenant_id);

-- Step 4: Enable RLS
ALTER TABLE tenant_identity ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_membership ENABLE ROW LEVEL SECURITY;

-- Step 5: RLS policies (allow service role full access)
CREATE POLICY "Service role has full access to tenant_identity" ON tenant_identity
  FOR ALL USING (true) WITH CHECK (true);

CREATE POLICY "Service role has full access to tenant_membership" ON tenant_membership
  FOR ALL USING (true) WITH CHECK (true);

-- Step 6: Migrate existing tenant_user and tenant_user_credentials data to new tables
-- First, create identities from existing credentials (password-based users)
INSERT INTO tenant_identity (id, email, first_name, last_name, password_hash, is_temporary, reset_token, reset_token_expires, last_login, failed_attempts, locked_until, created_at, updated_at)
SELECT 
  gen_random_uuid()::text,
  tuc.email,
  tu.first_name,
  tu.last_name,
  tuc.password_hash,
  tuc.is_temporary,
  tuc.reset_token,
  tuc.reset_token_expires,
  tuc.last_login,
  tuc.failed_attempts,
  tuc.locked_until,
  COALESCE(tu.created_at, NOW()),
  NOW()
FROM tenant_user_credentials tuc
JOIN tenant_user tu ON tu.id = tuc.tenant_user_id
ON CONFLICT (email) DO NOTHING;

-- Also create identities for Google-only users (no credentials record)
INSERT INTO tenant_identity (id, email, first_name, last_name, google_id, created_at, updated_at)
SELECT 
  gen_random_uuid()::text,
  tu.email,
  tu.first_name,
  tu.last_name,
  tu.google_id,
  COALESCE(tu.created_at, NOW()),
  NOW()
FROM tenant_user tu
WHERE tu.google_id IS NOT NULL
AND NOT EXISTS (
  SELECT 1 FROM tenant_user_credentials tuc WHERE tuc.tenant_user_id = tu.id
)
ON CONFLICT (email) DO UPDATE SET google_id = EXCLUDED.google_id WHERE tenant_identity.google_id IS NULL;

-- Then, create memberships for password-based users
INSERT INTO tenant_membership (id, identity_id, tenant_id, role, status, is_default, created_at, updated_at)
SELECT 
  gen_random_uuid()::text,
  ti.id,
  tu.tenant_id,
  tu.role,
  tu.status,
  true, -- First tenant becomes default
  tu.created_at,
  NOW()
FROM tenant_user tu
JOIN tenant_user_credentials tuc ON tuc.tenant_user_id = tu.id
JOIN tenant_identity ti ON ti.email = tuc.email
ON CONFLICT (identity_id, tenant_id) DO NOTHING;

-- Create memberships for Google-only users
INSERT INTO tenant_membership (id, identity_id, tenant_id, role, status, is_default, created_at, updated_at)
SELECT 
  gen_random_uuid()::text,
  ti.id,
  tu.tenant_id,
  tu.role,
  tu.status,
  true,
  tu.created_at,
  NOW()
FROM tenant_user tu
JOIN tenant_identity ti ON ti.email = tu.email
WHERE tu.google_id IS NOT NULL
AND NOT EXISTS (
  SELECT 1 FROM tenant_user_credentials tuc WHERE tuc.tenant_user_id = tu.id
)
ON CONFLICT (identity_id, tenant_id) DO NOTHING;

-- Step 7: Add identity_id column to tenant_user for reference during transition
-- This allows us to keep the old tables working while we migrate the auth system
ALTER TABLE tenant_user ADD COLUMN IF NOT EXISTS identity_id VARCHAR REFERENCES tenant_identity(id);

-- Update tenant_user.identity_id based on email match (for password-based users)
UPDATE tenant_user tu
SET identity_id = ti.id
FROM tenant_user_credentials tuc, tenant_identity ti
WHERE tuc.tenant_user_id = tu.id
AND ti.email = tuc.email;

-- Also update identity_id for Google-only users
UPDATE tenant_user tu
SET identity_id = ti.id
FROM tenant_identity ti
WHERE ti.email = tu.email
AND tu.google_id IS NOT NULL
AND tu.identity_id IS NULL;

-- Step 8: Create trigger to keep updated_at current
CREATE OR REPLACE FUNCTION update_tenant_identity_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_tenant_identity_updated_at
  BEFORE UPDATE ON tenant_identity
  FOR EACH ROW
  EXECUTE FUNCTION update_tenant_identity_updated_at();

CREATE OR REPLACE FUNCTION update_tenant_membership_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_tenant_membership_updated_at
  BEFORE UPDATE ON tenant_membership
  FOR EACH ROW
  EXECUTE FUNCTION update_tenant_membership_updated_at();

-- Verify migration
SELECT 
  'tenant_identity' as table_name, 
  COUNT(*) as record_count 
FROM tenant_identity
UNION ALL
SELECT 
  'tenant_membership' as table_name, 
  COUNT(*) as record_count 
FROM tenant_membership;
