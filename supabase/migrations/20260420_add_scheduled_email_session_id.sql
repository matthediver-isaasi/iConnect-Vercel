-- Add session_id to scheduled_email for per-session reminder tracking
-- on complex (multi-session) events. Mirrors the DDL in
-- docs/event_email_schema.sql which had never been turned into a
-- numbered migration, so production was missing the column and every
-- per-session reminder write was failing with
-- "column scheduled_email.session_id does not exist".
--
-- Safe to re-run: every statement uses IF NOT EXISTS.
--
-- PREFLIGHT (run this first against prod; if it returns any rows,
-- resolve duplicates before applying the migration or the unique
-- index creation will fail):
--
--   SELECT event_email_id, booking_id,
--          COALESCE(session_id, '00000000-0000-0000-0000-000000000000') AS sid_key,
--          COUNT(*) AS dup_count
--     FROM scheduled_email
--    GROUP BY 1, 2, 3
--   HAVING COUNT(*) > 1;

ALTER TABLE scheduled_email
  ADD COLUMN IF NOT EXISTS session_id UUID;

CREATE INDEX IF NOT EXISTS idx_scheduled_email_session
  ON scheduled_email(session_id)
  WHERE session_id IS NOT NULL;

-- Unique per booking + email + session. Single-session bookings have
-- session_id IS NULL; the COALESCE sentinel collapses those into a
-- single key so the dedupe still works for the non-complex path.
CREATE UNIQUE INDEX IF NOT EXISTS idx_scheduled_email_unique
  ON scheduled_email(
    event_email_id,
    booking_id,
    COALESCE(session_id, '00000000-0000-0000-0000-000000000000')
  );
