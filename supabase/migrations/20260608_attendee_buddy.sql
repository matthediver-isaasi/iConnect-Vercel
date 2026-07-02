-- Task #1290: Attendee "Buddy" flag.
--
-- Admins can mark an attendee as a "Buddy" from the Event Registration Report.
-- The flag is stored on the booking record and surfaced on the QR check-in
-- screen and the check-in dashboard so door staff can spot buddies at a glance.
--
-- Idempotent: safe to run multiple times.

ALTER TABLE booking ADD COLUMN IF NOT EXISTS buddy BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE complex_event_booking ADD COLUMN IF NOT EXISTS buddy BOOLEAN NOT NULL DEFAULT false;

-- Ask PostgREST to reload its schema cache so the new column is queryable.
NOTIFY pgrst, 'reload schema';
