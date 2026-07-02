-- Migration: Fix member email uniqueness for multi-tenant
-- This changes the global email unique constraint to be per-tenant
-- Allowing the same email to have member records in different tenants

-- Step 1: Add tenant_id column to member table (denormalized for indexing)
ALTER TABLE member ADD COLUMN IF NOT EXISTS tenant_id UUID;

-- Step 2: Backfill tenant_id from organization.tenant_id
UPDATE member m
SET tenant_id = o.tenant_id
FROM organization o
WHERE m.organization_id = o.id
AND m.tenant_id IS NULL;

-- Step 3: Verify no NULL tenant_ids remain (should return 0 rows)
-- SELECT id, email, organization_id FROM member WHERE tenant_id IS NULL;

-- Step 4: Drop the old global unique index
DROP INDEX IF EXISTS member_email_unique_ci_idx;

-- Step 5: Create new unique index scoped by tenant
CREATE UNIQUE INDEX IF NOT EXISTS member_email_tenant_unique_ci_idx 
ON member (tenant_id, lower(TRIM(BOTH FROM email)));

-- Step 6: Add NOT NULL constraint after backfill is verified
-- (Run this separately after confirming Step 3 returns 0 rows)
-- ALTER TABLE member ALTER COLUMN tenant_id SET NOT NULL;

-- Step 7: Add trigger to auto-populate tenant_id on insert
CREATE OR REPLACE FUNCTION set_member_tenant_id()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.tenant_id IS NULL AND NEW.organization_id IS NOT NULL THEN
    SELECT tenant_id INTO NEW.tenant_id
    FROM organization
    WHERE id = NEW.organization_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_set_member_tenant_id ON member;
CREATE TRIGGER trigger_set_member_tenant_id
BEFORE INSERT ON member
FOR EACH ROW
EXECUTE FUNCTION set_member_tenant_id();

-- Verification queries (run these to confirm migration success):
-- 1. Check all members have tenant_id:
--    SELECT COUNT(*) FROM member WHERE tenant_id IS NULL;
-- 2. Verify new index exists:
--    SELECT indexname FROM pg_indexes WHERE tablename = 'member' AND indexname LIKE '%email%';
