-- Migration: Repair cross-tenant data leaks discovered by task-631
--
-- Background
-- ----------
-- The /organisations and /members CRM filter sidebars rely on
--   - preference_field (TENANT scope, has tenant_id)
--   - organization (TENANT scope, has tenant_id)
--   - role (TENANT scope, has tenant_id)
--   - organization_preference_value (ORGANIZATION scope, no tenant_id - joins via organization)
--   - member_preference_value (MEMBER scope, no tenant_id - joins via member)
--
-- Audit findings on the production schema (Supabase project lvmzliemqnieeoruhkik):
--   * preference_field: 0 rows with NULL tenant_id (clean)
--   * role:             0 rows with NULL tenant_id (clean)
--   * organization:     0 rows with NULL tenant_id (clean)
--   * organization_preference_value: 1 row whose organization belongs to one tenant
--                                    while its preference_field belongs to another.
--                                    This row is invisible to either tenant when
--                                    filtering is correct, but is still inconsistent
--                                    data that should be removed.
--   * member_preference_value:        2 rows with the same kind of cross-tenant
--                                     mismatch (member tenant != preference_field tenant).
--   * member: 2 rows with NULL tenant_id (cannot be displayed by tenant scoped queries
--             - safe but should be backfilled or reviewed).
--
-- This script is idempotent and can be re-run safely. It only deletes rows whose
-- owning entity (organization / member) belongs to a different tenant than the
-- preference_field referenced by the value row. Such rows can never legitimately
-- be displayed under the multi-tenant model and have no other consumer.
--
-- IMPORTANT
-- ---------
-- Run this in the Supabase SQL Editor against the production database
-- (project lvmzliemqnieeoruhkik). It uses CTEs only - no schema changes.

BEGIN;

-- 1. Snapshot the rows we're about to delete so they appear in NOTICE output.
DO $$
DECLARE
  bad_opv_count INTEGER;
  bad_mpv_count INTEGER;
  null_member_count INTEGER;
BEGIN
  SELECT COUNT(*) INTO bad_opv_count
  FROM organization_preference_value opv
  JOIN organization o ON o.id = opv.organization_id
  JOIN preference_field pf ON pf.id = opv.field_id
  WHERE o.tenant_id IS NOT NULL
    AND pf.tenant_id IS NOT NULL
    AND o.tenant_id <> pf.tenant_id;

  SELECT COUNT(*) INTO bad_mpv_count
  FROM member_preference_value mpv
  JOIN member m ON m.id = mpv.member_id
  JOIN preference_field pf ON pf.id = mpv.field_id
  WHERE m.tenant_id IS NOT NULL
    AND pf.tenant_id IS NOT NULL
    AND m.tenant_id <> pf.tenant_id;

  SELECT COUNT(*) INTO null_member_count
  FROM member
  WHERE tenant_id IS NULL;

  RAISE NOTICE 'Cross-tenant repair: % organization_preference_value rows to delete', bad_opv_count;
  RAISE NOTICE 'Cross-tenant repair: % member_preference_value rows to delete', bad_mpv_count;
  RAISE NOTICE 'Cross-tenant repair: % members with NULL tenant_id (will attempt backfill)', null_member_count;
END $$;

-- 2. Delete organization_preference_value rows whose owning organization belongs
--    to a different tenant than the preference_field they reference.
--    These rows would never render in any tenant under correct filtering and
--    are pure data corruption from earlier migration / sync runs.
WITH bad_rows AS (
  SELECT opv.id
  FROM organization_preference_value opv
  JOIN organization o ON o.id = opv.organization_id
  JOIN preference_field pf ON pf.id = opv.field_id
  WHERE o.tenant_id IS NOT NULL
    AND pf.tenant_id IS NOT NULL
    AND o.tenant_id <> pf.tenant_id
)
DELETE FROM organization_preference_value
WHERE id IN (SELECT id FROM bad_rows);

-- 3. Same repair for member_preference_value.
WITH bad_rows AS (
  SELECT mpv.id
  FROM member_preference_value mpv
  JOIN member m ON m.id = mpv.member_id
  JOIN preference_field pf ON pf.id = mpv.field_id
  WHERE m.tenant_id IS NOT NULL
    AND pf.tenant_id IS NOT NULL
    AND m.tenant_id <> pf.tenant_id
)
DELETE FROM member_preference_value
WHERE id IN (SELECT id FROM bad_rows);

-- 4. Backfill member.tenant_id from organization for any member that still has
--    NULL tenant_id but does belong to an organization with a known tenant.
--    Members that have neither an organization nor a tenant are reported below
--    and left untouched - they need manual review.
UPDATE member m
SET tenant_id = o.tenant_id
FROM organization o
WHERE m.tenant_id IS NULL
  AND m.organization_id = o.id
  AND o.tenant_id IS NOT NULL;

-- 5. Final report - any remaining anomalies require manual decision.
DO $$
DECLARE
  remaining_bad_opv INTEGER;
  remaining_bad_mpv INTEGER;
  remaining_null_member INTEGER;
BEGIN
  SELECT COUNT(*) INTO remaining_bad_opv
  FROM organization_preference_value opv
  JOIN organization o ON o.id = opv.organization_id
  JOIN preference_field pf ON pf.id = opv.field_id
  WHERE o.tenant_id IS NOT NULL
    AND pf.tenant_id IS NOT NULL
    AND o.tenant_id <> pf.tenant_id;

  SELECT COUNT(*) INTO remaining_bad_mpv
  FROM member_preference_value mpv
  JOIN member m ON m.id = mpv.member_id
  JOIN preference_field pf ON pf.id = mpv.field_id
  WHERE m.tenant_id IS NOT NULL
    AND pf.tenant_id IS NOT NULL
    AND m.tenant_id <> pf.tenant_id;

  SELECT COUNT(*) INTO remaining_null_member
  FROM member
  WHERE tenant_id IS NULL;

  RAISE NOTICE 'After repair: % cross-tenant organization_preference_value rows remain (expected 0)', remaining_bad_opv;
  RAISE NOTICE 'After repair: % cross-tenant member_preference_value rows remain (expected 0)', remaining_bad_mpv;
  RAISE NOTICE 'After repair: % members with NULL tenant_id remain (manual review if > 0)', remaining_null_member;
END $$;

COMMIT;
