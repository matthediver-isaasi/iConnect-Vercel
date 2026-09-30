-- Task #1177: Live attendee report (realtime + un-scan / deregister).
--
-- Adds reversal (un-scan) audit columns to the two check-in tables and
-- publishes both tables for Supabase realtime so the Event Check-In dashboard
-- can update live as attendees are scanned/checked in.
--
-- "Deregister" here only undoes a check-in: it returns the attendee to
-- "not checked in" and records why/who/when. It does NOT touch the booking,
-- refunds, seats, or emails.
--
-- Idempotent: safe to run multiple times. Additive only — existing check-in
-- columns are untouched.

-- 1. Reversal audit columns (when un-scanned, by whom, and the reason).
ALTER TABLE booking ADD COLUMN IF NOT EXISTS check_in_reversed_at TIMESTAMPTZ;
ALTER TABLE booking ADD COLUMN IF NOT EXISTS check_in_reversed_by TEXT;
ALTER TABLE booking ADD COLUMN IF NOT EXISTS check_in_reversal_reason TEXT;

ALTER TABLE complex_event_session_checkin ADD COLUMN IF NOT EXISTS check_in_reversed_at TIMESTAMPTZ;
ALTER TABLE complex_event_session_checkin ADD COLUMN IF NOT EXISTS check_in_reversed_by TEXT;
ALTER TABLE complex_event_session_checkin ADD COLUMN IF NOT EXISTS check_in_reversal_reason TEXT;

-- 2. Publish both check-in tables for Supabase realtime (idempotent).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND tablename = 'booking'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE booking;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND tablename = 'complex_event_session_checkin'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE complex_event_session_checkin;
  END IF;
END $$;
