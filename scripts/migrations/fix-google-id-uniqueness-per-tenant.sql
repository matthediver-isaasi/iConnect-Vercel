-- Migration: Fix google_id uniqueness for multi-tenant
-- This changes the global google_id unique constraint to be per-tenant
-- Allowing the same Google account to have records in different tenants

-- ============================================
-- PART 1: FIX MEMBER TABLE
-- ============================================

-- Step 1: Drop any global unique constraint on member.google_id
-- IMPORTANT: Drop the constraint FIRST, then the index will be removed automatically
ALTER TABLE member DROP CONSTRAINT IF EXISTS member_google_id_key;
ALTER TABLE member DROP CONSTRAINT IF EXISTS member_google_id_unique;

-- Drop any standalone indexes that might exist (without backing constraints)
DROP INDEX IF EXISTS member_google_id_idx;
DROP INDEX IF EXISTS member_google_id_unique_idx;

-- Step 2: Create new unique index scoped by tenant (partial - only when google_id is not null)
DROP INDEX IF EXISTS member_google_id_tenant_unique_idx;
CREATE UNIQUE INDEX member_google_id_tenant_unique_idx 
ON member (tenant_id, google_id) 
WHERE google_id IS NOT NULL;

-- ============================================
-- PART 2: FIX TENANT_USER TABLE
-- ============================================

-- Step 1: Drop any global unique constraint on tenant_user.google_id
-- IMPORTANT: Drop the constraint FIRST, then the index will be removed automatically
ALTER TABLE tenant_user DROP CONSTRAINT IF EXISTS tenant_user_google_id_key;
ALTER TABLE tenant_user DROP CONSTRAINT IF EXISTS tenant_user_google_id_unique;

-- Drop any standalone indexes that might exist (without backing constraints)
DROP INDEX IF EXISTS tenant_user_google_id_idx;
DROP INDEX IF EXISTS tenant_user_google_id_unique_idx;

-- Step 2: Create new unique index scoped by tenant (partial - only when google_id is not null)
DROP INDEX IF EXISTS tenant_user_google_id_tenant_unique_idx;
CREATE UNIQUE INDEX tenant_user_google_id_tenant_unique_idx 
ON tenant_user (tenant_id, google_id) 
WHERE google_id IS NOT NULL;

-- ============================================
-- VERIFICATION QUERIES
-- ============================================
-- Run these to confirm migration success:

-- 1. Check no global unique indexes remain on google_id:
-- SELECT indexname, indexdef FROM pg_indexes 
-- WHERE tablename IN ('member', 'tenant_user') AND indexname LIKE '%google_id%';

-- 2. Verify the new tenant-scoped indexes exist:
-- SELECT indexname FROM pg_indexes 
-- WHERE indexname IN ('member_google_id_tenant_unique_idx', 'tenant_user_google_id_tenant_unique_idx');

-- 3. Test that same google_id can exist in multiple tenants:
-- (This should now succeed without constraint violation)
