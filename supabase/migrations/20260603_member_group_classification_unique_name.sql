-- Task #1243: Stop duplicate member group classification names.
--
-- Names must be unique per tenant (case-insensitive) so the Member Group
-- Management list stays clean and filtering/grouping isn't ambiguous.
--
-- The original feature (Task #1242) allowed duplicates, so existing rows may
-- collide on (tenant_id, lower(name)). Before adding the unique index we
-- deterministically merge duplicates: keep the oldest row per
-- (tenant_id, lower(name)) (tie-break on id), re-point any member_group rows
-- that referenced a losing duplicate to the kept row, then delete the losers.
--
-- Idempotent: safe to run multiple times. Once de-duped and indexed, the
-- merge steps are no-ops.

DO $$
BEGIN
  IF to_regclass('public.member_group_classification') IS NULL THEN
    RAISE NOTICE 'member_group_classification does not exist yet; skipping.';
    RETURN;
  END IF;

  -- Build a map of each duplicate row -> the canonical (kept) row for its
  -- (tenant_id, lower(name)) group.
  CREATE TEMP TABLE _mgc_dupe_map ON COMMIT DROP AS
  WITH ranked AS (
    SELECT
      id,
      tenant_id,
      lower(name) AS lname,
      first_value(id) OVER (
        PARTITION BY tenant_id, lower(name)
        ORDER BY created_at ASC NULLS LAST, id ASC
      ) AS keep_id
    FROM member_group_classification
  )
  SELECT id AS dupe_id, keep_id
  FROM ranked
  WHERE id <> keep_id;

  -- Re-point member groups that referenced a losing duplicate.
  UPDATE member_group mg
  SET classification_id = m.keep_id
  FROM _mgc_dupe_map m
  WHERE mg.classification_id = m.dupe_id;

  -- Delete the losing duplicate classification rows.
  DELETE FROM member_group_classification c
  USING _mgc_dupe_map m
  WHERE c.id = m.dupe_id;
END $$;

-- Enforce case-insensitive uniqueness per tenant going forward.
CREATE UNIQUE INDEX IF NOT EXISTS uq_member_group_classification_tenant_name
  ON member_group_classification(tenant_id, lower(name));
