-- Task #1519: Member group admins create real events (limited).
-- Adds member_group_id to complex_event so Group Admins can scope a real
-- complex event to a group they administer (the simple `event` table already
-- has this column). Nullable FK -> member_group(id) ON DELETE SET NULL, plus an
-- index for filtering events by group. Idempotent; safe to re-run.

ALTER TABLE complex_event
  ADD COLUMN IF NOT EXISTS member_group_id UUID;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'complex_event_member_group_id_fkey'
      AND table_name = 'complex_event'
  ) THEN
    ALTER TABLE complex_event
      ADD CONSTRAINT complex_event_member_group_id_fkey
      FOREIGN KEY (member_group_id) REFERENCES member_group(id) ON DELETE SET NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_complex_event_member_group_id
  ON complex_event (member_group_id);
