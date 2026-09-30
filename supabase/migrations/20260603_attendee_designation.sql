-- Task #1229: Attendee Designation field on imported bookings.
--
-- Admins can attach an optional free-text "Designation" (e.g. "VIP Guest",
-- "Press") to attendees added via the Import Attendees modal. The value is
-- stored on the booking record and surfaced on the QR check-in screen.
--
-- Idempotent: safe to run multiple times.

ALTER TABLE booking ADD COLUMN IF NOT EXISTS designation TEXT;
ALTER TABLE complex_event_booking ADD COLUMN IF NOT EXISTS designation TEXT;
