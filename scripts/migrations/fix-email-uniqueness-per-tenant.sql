-- Migration: Fix email uniqueness to be per-tenant instead of global
-- Run this SQL in your Supabase SQL Editor
-- 
-- This migration:
-- 1. Drops the global unique constraint on email in member_credentials
-- 2. Adds tenant_id column to member_credentials for easier querying
-- 3. Creates a per-tenant unique constraint on (tenant_id, email)
-- 4. Backfills tenant_id from the member table

-- ============================================
-- STEP 1: Add tenant_id column to member_credentials
-- ============================================
ALTER TABLE member_credentials 
ADD COLUMN IF NOT EXISTS tenant_id VARCHAR;

-- ============================================
-- STEP 2: Backfill tenant_id from member table
-- ============================================
UPDATE member_credentials mc
SET tenant_id = m.tenant_id
FROM member m
WHERE mc.member_id = m.id
AND mc.tenant_id IS NULL;

-- ============================================
-- STEP 3: Drop the global unique constraint on email
-- ============================================
-- First, find and drop any existing unique constraint or index on email
DO $$
DECLARE
    constraint_name TEXT;
BEGIN
    -- Find unique constraint
    SELECT conname INTO constraint_name
    FROM pg_constraint
    WHERE conrelid = 'member_credentials'::regclass
    AND contype = 'u'
    AND array_length(conkey, 1) = 1
    AND conkey[1] = (
        SELECT attnum FROM pg_attribute 
        WHERE attrelid = 'member_credentials'::regclass 
        AND attname = 'email'
    );
    
    IF constraint_name IS NOT NULL THEN
        EXECUTE format('ALTER TABLE member_credentials DROP CONSTRAINT %I', constraint_name);
        RAISE NOTICE 'Dropped unique constraint: %', constraint_name;
    END IF;
END $$;

-- Also drop any unique index on email alone
DROP INDEX IF EXISTS member_credentials_email_key;
DROP INDEX IF EXISTS idx_member_credentials_email_unique;

-- ============================================
-- STEP 4: Create per-tenant unique constraint
-- ============================================
-- Create unique constraint on (tenant_id, email)
ALTER TABLE member_credentials
ADD CONSTRAINT member_credentials_tenant_email_unique 
UNIQUE (tenant_id, email);

-- ============================================
-- STEP 5: Create index for email lookups
-- ============================================
CREATE INDEX IF NOT EXISTS idx_member_credentials_email 
ON member_credentials(email);

CREATE INDEX IF NOT EXISTS idx_member_credentials_tenant_id 
ON member_credentials(tenant_id);

-- ============================================
-- STEP 6: Make tenant_id NOT NULL going forward
-- ============================================
-- Only do this if all rows have tenant_id populated
DO $$
DECLARE
    null_count INTEGER;
BEGIN
    SELECT COUNT(*) INTO null_count 
    FROM member_credentials 
    WHERE tenant_id IS NULL;
    
    IF null_count = 0 THEN
        ALTER TABLE member_credentials ALTER COLUMN tenant_id SET NOT NULL;
        RAISE NOTICE 'Set tenant_id to NOT NULL';
    ELSE
        RAISE NOTICE 'Warning: % rows still have NULL tenant_id. NOT NULL constraint not applied.', null_count;
    END IF;
END $$;

-- ============================================
-- Verification
-- ============================================
SELECT 
    'member_credentials' as table_name,
    (SELECT COUNT(*) FROM member_credentials) as total_rows,
    (SELECT COUNT(*) FROM member_credentials WHERE tenant_id IS NOT NULL) as rows_with_tenant_id;
