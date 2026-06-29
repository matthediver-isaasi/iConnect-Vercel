-- Gate duplicate member group assignments.
--
-- The same member (or guest) must never be assigned to the same group twice.
-- The existing duplicate check only ran for non-admin self-join; the admin
-- assign path had no guard. This migration provides the database-level backstop.
--
-- Steps:
--   1. Deterministically remove any pre-existing exact-duplicate assignment
--      rows: keep the lowest id per (group_id, member_id) and per
--      (group_id, guest_id). member_group_assignment has no created_at, so
--      id ASC is the only stable ordering available.
--   2. Create partial unique indexes:
--        - (group_id, member_id) WHERE member_id IS NOT NULL
--        - (group_id, guest_id)  WHERE guest_id  IS NOT NULL
--
-- Idempotent: safe to run multiple times.

DO $$
BEGIN
  IF to_regclass('public.member_group_assignment') IS NULL THEN
    RAISE NOTICE 'member_group_assignment does not exist yet; skipping.';
    RETURN;
  END IF;

  -- 1a. Remove exact-duplicate (group_id, member_id) rows, keeping lowest id.
  DELETE FROM member_group_assignment a
  USING (
    SELECT MIN(id) AS keep_id, group_id, member_id
    FROM member_group_assignment
    WHERE member_id IS NOT NULL
    GROUP BY group_id, member_id
    HAVING COUNT(*) > 1
  ) dupes
  WHERE a.group_id = dupes.group_id
    AND a.member_id = dupes.member_id
    AND a.id <> dupes.keep_id;

  -- 1b. Remove exact-duplicate (group_id, guest_id) rows, keeping lowest id.
  DELETE FROM member_group_assignment a
  USING (
    SELECT MIN(id) AS keep_id, group_id, guest_id
    FROM member_group_assignment
    WHERE guest_id IS NOT NULL
    GROUP BY group_id, guest_id
    HAVING COUNT(*) > 1
  ) dupes
  WHERE a.group_id = dupes.group_id
    AND a.guest_id = dupes.guest_id
    AND a.id <> dupes.keep_id;
END $$;

-- 2. Partial unique indexes (idempotent via IF NOT EXISTS).
CREATE UNIQUE INDEX IF NOT EXISTS uq_member_group_assignment_member
  ON member_group_assignment(group_id, member_id)
  WHERE member_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_member_group_assignment_guest
  ON member_group_assignment(group_id, guest_id)
  WHERE guest_id IS NOT NULL;
