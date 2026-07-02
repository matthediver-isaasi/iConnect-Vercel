-- Migration: Add tenant_id to preference_field for proper multi-tenant scoping
-- Run this SQL in your Supabase SQL Editor
-- 
-- Background: preference_field was originally global, but forms are tenant-scoped
-- so preference fields should also be tenant-scoped for proper data isolation.

-- Step 1: Add tenant_id column (nuhttps://gsf.iconn.app/organisationsllable initially for backfill)
ALTER TABLE preference_field 
ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES tenant(id) ON DELETE CASCADE;

-- Step 2: Create index for tenant_id lookups
CREATE INDEX IF NOT EXISTS idx_preference_field_tenant ON preference_field(tenant_id);

-- Step 3: Backfill tenant_id from organization_preference_value -> organization -> tenant
-- This covers organization-scoped preference fields
UPDATE preference_field pf
SET tenant_id = sub.tenant_id
FROM (
  SELECT DISTINCT pf2.id as field_id, o.tenant_id
  FROM preference_field pf2
  JOIN organization_preference_value opv ON opv.field_id = pf2.id
  JOIN organization o ON o.id = opv.organization_id
  WHERE pf2.tenant_id IS NULL
) sub
WHERE pf.id = sub.field_id AND pf.tenant_id IS NULL;

-- Step 4: Backfill tenant_id from member_preference_value -> member -> organization -> tenant
-- This covers member-scoped preference fields (members belong to organizations which belong to tenants)
UPDATE preference_field pf
SET tenant_id = sub.tenant_id
FROM (
  SELECT DISTINCT pf2.id as field_id, o.tenant_id
  FROM preference_field pf2
  JOIN member_preference_value mpv ON mpv.field_id = pf2.id
  JOIN member m ON m.id = mpv.member_id
  JOIN organization o ON o.id = m.organization_id
  WHERE pf2.tenant_id IS NULL
    AND o.tenant_id IS NOT NULL
) sub
WHERE pf.id = sub.field_id AND pf.tenant_id IS NULL;

-- Step 5: Backfill from form.fields JSON that references preference fields
-- Form fields have custom_field_id that references preference_field.id
-- Uses safe UUID parsing to handle any malformed data
UPDATE preference_field pf
SET tenant_id = sub.tenant_id
FROM (
  SELECT DISTINCT 
    field_id,
    f.tenant_id
  FROM form f,
  LATERAL (
    SELECT 
      CASE 
        WHEN field->>'custom_field_id' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        THEN (field->>'custom_field_id')::uuid
        ELSE NULL
      END as field_id
    FROM jsonb_array_elements(f.fields) as field
    WHERE field->>'custom_field_id' IS NOT NULL
  ) parsed
  WHERE parsed.field_id IS NOT NULL
) sub
WHERE pf.id = sub.field_id AND pf.tenant_id IS NULL;

-- Step 6: Log any remaining NULL tenant_id records for manual review
-- These are orphaned fields not used by any tenant
DO $$
DECLARE
  orphan_count INTEGER;
BEGIN
  SELECT COUNT(*) INTO orphan_count FROM preference_field WHERE tenant_id IS NULL;
  IF orphan_count > 0 THEN
    RAISE NOTICE 'WARNING: % preference_field records have NULL tenant_id and need manual review', orphan_count;
  END IF;
END $$;

-- Step 7: Make tenant_id required after backfill
-- IMPORTANT: Only run this after verifying Step 6 shows 0 orphan records
-- If orphans exist, either delete them or manually assign tenant_id first
ALTER TABLE preference_field ALTER COLUMN tenant_id SET NOT NULL;

-- Step 8: Update RLS policy to include tenant scoping
DROP POLICY IF EXISTS "Anyone can read active preference fields" ON preference_field;
CREATE POLICY "Anyone can read active preference fields for tenant" ON preference_field
  FOR SELECT USING (is_active = true);

-- Note: The actual tenant filtering should be done at the application level
-- since RLS doesn't have access to request context for subdomain/query param tenant resolution

-- Step 9: Remove the unique constraint on name (if it exists) since names can repeat across tenants
ALTER TABLE preference_field DROP CONSTRAINT IF EXISTS preference_field_name_key;

-- Step 10: Add a unique constraint on (tenant_id, name) to ensure field names are unique per tenant
ALTER TABLE preference_field ADD CONSTRAINT preference_field_tenant_name_unique UNIQUE (tenant_id, name);

COMMENT ON COLUMN preference_field.tenant_id IS 'Tenant this preference field belongs to. All preference fields are tenant-scoped.';
