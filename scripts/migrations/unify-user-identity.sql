-- Migration: Unify User Identity System
-- This extends tenant_identity to cover ALL users (owners AND members)
-- Allowing any user to belong to multiple tenants with a single identity
-- Run this AFTER: add-multi-tenant-identity.sql and fix-member-email-uniqueness-per-tenant.sql

-- ============================================================================
-- PART 1: Extend tenant_membership to support member relationships
-- ============================================================================

-- Add member_id column to link identity to specific member records
ALTER TABLE tenant_membership ADD COLUMN IF NOT EXISTS member_id VARCHAR;

-- Add membership_type to distinguish owner access vs member access
-- 'owner' = tenant owner/admin (can manage tenant settings)
-- 'member' = organizational member (access through member portal)
ALTER TABLE tenant_membership ADD COLUMN IF NOT EXISTS membership_type VARCHAR DEFAULT 'owner';

-- Update existing memberships to be 'owner' type (these were created for tenant owners)
UPDATE tenant_membership SET membership_type = 'owner' WHERE membership_type IS NULL;

-- Create index for member_id lookups
CREATE INDEX IF NOT EXISTS idx_tenant_membership_member_id ON tenant_membership(member_id);

-- ============================================================================
-- PART 2: Add identity_id to member table for direct linking
-- ============================================================================

ALTER TABLE member ADD COLUMN IF NOT EXISTS identity_id VARCHAR;

-- ============================================================================
-- PART 3: Migrate existing member_credentials to tenant_identity
-- ============================================================================

-- Create identities for members who have credentials but no identity yet
INSERT INTO tenant_identity (id, email, first_name, last_name, password_hash, is_temporary, reset_token, reset_token_expires, last_login, failed_attempts, locked_until, created_at, updated_at)
SELECT 
  gen_random_uuid()::text,
  mc.email,
  m.first_name,
  m.last_name,
  mc.password_hash,
  mc.is_temporary,
  mc.reset_token,
  mc.reset_token_expires,
  mc.last_login,
  mc.failed_attempts,
  mc.locked_until,
  COALESCE(m.created_at, NOW()),
  NOW()
FROM member_credentials mc
JOIN member m ON m.id = mc.member_id
WHERE NOT EXISTS (
  SELECT 1 FROM tenant_identity ti WHERE ti.email = mc.email
)
ON CONFLICT (email) DO NOTHING;

-- Create identities for members with Google login but no credentials
INSERT INTO tenant_identity (id, email, first_name, last_name, google_id, created_at, updated_at)
SELECT 
  gen_random_uuid()::text,
  m.email,
  m.first_name,
  m.last_name,
  m.google_id,
  COALESCE(m.created_at, NOW()),
  NOW()
FROM member m
WHERE m.google_id IS NOT NULL
AND m.login_enabled = true
AND NOT EXISTS (
  SELECT 1 FROM tenant_identity ti WHERE ti.email = m.email
)
ON CONFLICT (email) DO UPDATE SET google_id = EXCLUDED.google_id WHERE tenant_identity.google_id IS NULL;

-- ============================================================================
-- PART 4: Link members to their identities
-- ============================================================================

-- Update member.identity_id based on email match
UPDATE member m
SET identity_id = ti.id
FROM tenant_identity ti
WHERE ti.email = m.email
AND m.identity_id IS NULL
AND m.login_enabled = true;

-- ============================================================================
-- PART 5: Create tenant_membership records for members
-- ============================================================================

-- Get tenant_id from member -> organization -> tenant
INSERT INTO tenant_membership (id, identity_id, tenant_id, member_id, role, membership_type, status, is_default, created_at, updated_at)
SELECT 
  gen_random_uuid()::text,
  m.identity_id,
  o.tenant_id,
  m.id,
  'member',
  'member',
  m.status,
  false, -- Not default (their default tenant might be one they own)
  m.created_at,
  NOW()
FROM member m
JOIN organization o ON o.id = m.organization_id
WHERE m.identity_id IS NOT NULL
AND m.login_enabled = true
AND NOT EXISTS (
  SELECT 1 FROM tenant_membership tm 
  WHERE tm.identity_id = m.identity_id 
  AND tm.tenant_id = o.tenant_id
  AND tm.membership_type = 'member'
)
ON CONFLICT (identity_id, tenant_id) DO NOTHING;

-- ============================================================================
-- PART 6: Ensure at least one membership is marked as default per identity
-- ============================================================================

-- For identities with no default, set the oldest membership as default
WITH no_default AS (
  SELECT tm.identity_id
  FROM tenant_membership tm
  GROUP BY tm.identity_id
  HAVING SUM(CASE WHEN tm.is_default THEN 1 ELSE 0 END) = 0
),
oldest_per_identity AS (
  SELECT DISTINCT ON (tm.identity_id) tm.id
  FROM tenant_membership tm
  JOIN no_default nd ON nd.identity_id = tm.identity_id
  ORDER BY tm.identity_id, tm.created_at ASC
)
UPDATE tenant_membership tm
SET is_default = true
FROM oldest_per_identity opi
WHERE tm.id = opi.id;

-- ============================================================================
-- VERIFICATION QUERIES (run these to confirm migration success)
-- ============================================================================

-- Check member identity coverage
-- SELECT 
--   'Members with login_enabled' as metric,
--   COUNT(*) as count
-- FROM member WHERE login_enabled = true
-- UNION ALL
-- SELECT 
--   'Members with identity_id set' as metric,
--   COUNT(*) as count
-- FROM member WHERE identity_id IS NOT NULL AND login_enabled = true;

-- Check tenant_membership distribution
-- SELECT 
--   membership_type,
--   COUNT(*) as count
-- FROM tenant_membership
-- GROUP BY membership_type;

-- List users with access to multiple tenants
-- SELECT 
--   ti.email,
--   ti.first_name,
--   ti.last_name,
--   COUNT(DISTINCT tm.tenant_id) as tenant_count,
--   STRING_AGG(DISTINCT t.name, ', ') as tenants
-- FROM tenant_identity ti
-- JOIN tenant_membership tm ON tm.identity_id = ti.id
-- JOIN tenant t ON t.id = tm.tenant_id
-- GROUP BY ti.id, ti.email, ti.first_name, ti.last_name
-- HAVING COUNT(DISTINCT tm.tenant_id) > 1;
