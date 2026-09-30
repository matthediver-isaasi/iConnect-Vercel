-- Record when a member joined a group.
--
-- The member_group_assignment table previously had NO join/created timestamp,
-- so any backfill of the member-group activity log had to stamp pre-existing
-- memberships with the backfill run time (now()) instead of the true join date.
--
-- This adds a created_at column that defaults to now(), so all NEW assignments
-- capture their real join moment automatically. Existing rows are backfilled to
-- now() by the DEFAULT (their true historical join date is unrecoverable).
--
-- Idempotent: safe to run multiple times.

ALTER TABLE member_group_assignment
  ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();
