-- Migration: Make tenant_user_id nullable in portal_sso_token table
-- Purpose: Allow unified identity users to create portal SSO tokens without a legacy tenant_user record
-- Date: 2026-01-15

-- Step 1: Drop the foreign key constraint if it exists
ALTER TABLE portal_sso_token 
DROP CONSTRAINT IF EXISTS portal_sso_token_tenant_user_id_fkey;

-- Step 2: Make tenant_user_id nullable
ALTER TABLE portal_sso_token 
ALTER COLUMN tenant_user_id DROP NOT NULL;

-- Step 3: Add the foreign key back but allowing nulls
ALTER TABLE portal_sso_token 
ADD CONSTRAINT portal_sso_token_tenant_user_id_fkey 
FOREIGN KEY (tenant_user_id) REFERENCES tenant_user(id) ON DELETE SET NULL;

-- Add a comment explaining the change
COMMENT ON COLUMN portal_sso_token.tenant_user_id IS 'Optional - null for unified identity users who have no legacy tenant_user record';
