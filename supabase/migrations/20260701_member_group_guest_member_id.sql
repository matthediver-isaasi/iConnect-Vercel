-- Link member_group_guest rows to provisioned member records.
--
-- New guest creation now provisions a real `member` row and stores its id here.
-- Legacy rows (created before this change) have member_id = NULL and remain
-- roster-only; they are NOT backfilled.
--
-- Idempotent: safe to run multiple times.

ALTER TABLE member_group_guest
  ADD COLUMN IF NOT EXISTS member_id UUID REFERENCES member(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_member_group_guest_member_id
  ON member_group_guest(member_id)
  WHERE member_id IS NOT NULL;
