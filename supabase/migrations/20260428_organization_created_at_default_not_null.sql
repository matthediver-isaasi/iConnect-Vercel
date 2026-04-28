-- Migration: Ensure organization.created_at is always populated
--
-- Why:
--   The organization.created_at column had no DB-level default and several
--   creation paths (the generic entity POST endpoint, tenant provisioning,
--   fundraising auto-create-organisation, and inbound Zoho CRM sync) did not
--   set it explicitly. New orgs ended up with NULL "Created Date" in the
--   Organisations list and Organisation detail view.
--
-- This migration:
--   (a) Backfills any existing rows where organization.created_at IS NULL
--       using the best available historical timestamp:
--         1. Earliest member.created_at among members of that org.
--         2. Earliest form_submission.created_date for that org (matching
--            either form_submission.organization_id or
--            form_submission.created_organization_id).
--         3. Falls back to now() if no signal exists.
--   (b) Sets DEFAULT now() on organization.created_at so every future
--       creation path automatically gets a correct timestamp.
--   (c) Adds a NOT NULL constraint on organization.created_at so the column
--       can never be left blank again.
--
-- Idempotent and tenant-agnostic: safe to re-run, applies to all rows.

-- (a) Backfill NULL created_at values
WITH best_member AS (
  SELECT organization_id, MIN(created_at) AS earliest
  FROM member
  WHERE organization_id IS NOT NULL
    AND created_at IS NOT NULL
  GROUP BY organization_id
),
best_submission AS (
  SELECT org_id, MIN(created_date) AS earliest
  FROM (
    SELECT organization_id AS org_id, created_date
      FROM form_submission
      WHERE organization_id IS NOT NULL
        AND created_date IS NOT NULL
    UNION ALL
    SELECT created_organization_id AS org_id, created_date
      FROM form_submission
      WHERE created_organization_id IS NOT NULL
        AND created_date IS NOT NULL
  ) s
  GROUP BY org_id
),
target AS (
  SELECT id FROM organization WHERE created_at IS NULL
)
UPDATE organization o
SET created_at = COALESCE(bm.earliest, bs.earliest, now())
FROM target t
LEFT JOIN best_member bm ON bm.organization_id = t.id
LEFT JOIN best_submission bs ON bs.org_id = t.id
WHERE o.id = t.id
  AND o.created_at IS NULL;

-- (b) Default future inserts to now()
ALTER TABLE organization
  ALTER COLUMN created_at SET DEFAULT now();

-- (c) Enforce non-null
ALTER TABLE organization
  ALTER COLUMN created_at SET NOT NULL;
