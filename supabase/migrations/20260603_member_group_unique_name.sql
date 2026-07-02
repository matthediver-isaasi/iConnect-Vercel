-- Task #1245: Stop duplicate member group names.
--
-- Group names must be unique per tenant (case-insensitive) so assigning
-- members and filtering/grouping on the Member Group Management page isn't
-- ambiguous — the same problem Task #1243 fixed for classifications.
--
-- Member groups predate this rule, so existing rows may collide on
-- (tenant_id, lower(name)). Before adding the unique index we deterministically
-- merge duplicates: keep the lowest id per (tenant_id, lower(name)) group,
-- re-point everything that referenced a losing duplicate to the kept row, then
-- delete the losers. member_group has no created_at column, so id ASC is the
-- only ordering available.
--
-- Idempotent: safe to run multiple times. Once de-duped and indexed, the merge
-- steps are no-ops.

DO $$
BEGIN
  IF to_regclass('public.member_group') IS NULL THEN
    RAISE NOTICE 'member_group does not exist yet; skipping.';
    RETURN;
  END IF;

  -- Map each duplicate row -> the canonical (kept) row for its
  -- (tenant_id, lower(name)) group.
  CREATE TEMP TABLE _mg_dupe_map ON COMMIT DROP AS
  WITH ranked AS (
    SELECT
      id,
      tenant_id,
      lower(name) AS lname,
      first_value(id) OVER (
        PARTITION BY tenant_id, lower(name)
        ORDER BY id ASC
      ) AS keep_id
    FROM member_group
  )
  SELECT id AS dupe_id, keep_id
  FROM ranked
  WHERE id <> keep_id;

  -- Re-point group assignments, but drop any that would collide with an
  -- assignment already on the kept group for the same member/guest.
  IF to_regclass('public.member_group_assignment') IS NOT NULL THEN
    DELETE FROM member_group_assignment a
    USING _mg_dupe_map m
    WHERE a.group_id = m.dupe_id
      AND EXISTS (
        SELECT 1 FROM member_group_assignment k
        WHERE k.group_id = m.keep_id
          AND k.member_id IS NOT DISTINCT FROM a.member_id
          AND k.guest_id IS NOT DISTINCT FROM a.guest_id
      );

    UPDATE member_group_assignment a
    SET group_id = m.keep_id
    FROM _mg_dupe_map m
    WHERE a.group_id = m.dupe_id;
  END IF;

  -- Re-point nullable references that would otherwise be SET NULL on delete.
  IF to_regclass('public.email_campaign') IS NOT NULL THEN
    UPDATE email_campaign e
    SET member_group_id = m.keep_id
    FROM _mg_dupe_map m
    WHERE e.member_group_id = m.dupe_id;
  END IF;

  IF to_regclass('public.event') IS NOT NULL THEN
    UPDATE event ev
    SET member_group_id = m.keep_id
    FROM _mg_dupe_map m
    WHERE ev.member_group_id = m.dupe_id;
  END IF;

  IF to_regclass('public.project_board') IS NOT NULL THEN
    UPDATE project_board pb
    SET member_group_id = m.keep_id
    FROM _mg_dupe_map m
    WHERE pb.member_group_id = m.dupe_id;
  END IF;

  -- Re-point ticket-class member_group_ids JSONB arrays (de-duped after swap).
  IF to_regclass('public.complex_event_ticket_class') IS NOT NULL THEN
    UPDATE complex_event_ticket_class t
    SET member_group_ids = remapped.ids
    FROM (
      SELECT
        t2.id,
        to_jsonb(
          ARRAY(
            SELECT DISTINCT COALESCE(m.keep_id::text, elem)
            FROM jsonb_array_elements_text(t2.member_group_ids) AS elem
            LEFT JOIN _mg_dupe_map m ON m.dupe_id::text = elem
          )
        ) AS ids
      FROM complex_event_ticket_class t2
      WHERE EXISTS (
        SELECT 1
        FROM jsonb_array_elements_text(t2.member_group_ids) AS elem
        JOIN _mg_dupe_map m ON m.dupe_id::text = elem
      )
    ) AS remapped
    WHERE t.id = remapped.id;
  END IF;

  -- Delete the losing duplicate group rows.
  DELETE FROM member_group g
  USING _mg_dupe_map m
  WHERE g.id = m.dupe_id;
END $$;

-- Enforce case-insensitive uniqueness per tenant going forward.
CREATE UNIQUE INDEX IF NOT EXISTS uq_member_group_tenant_name
  ON member_group(tenant_id, lower(name));
