-- Task #1316: Attendee "Badge" flag.
--
-- Admins can mark whether an attendee requires a printed "Badge" from the
-- Event Registration Report. The flag defaults to TRUE (everyone gets a badge
-- unless explicitly toggled off). It is stored on the booking record and
-- surfaced on the QR check-in screen and the check-in dashboard so door staff
-- can see at a glance who needs a badge.
--
-- Idempotent: safe to run multiple times.

ALTER TABLE booking ADD COLUMN IF NOT EXISTS badge BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE complex_event_booking ADD COLUMN IF NOT EXISTS badge BOOLEAN NOT NULL DEFAULT true;

-- Ask PostgREST to reload its schema cache so the new column is queryable.
NOTIFY pgrst, 'reload schema';
