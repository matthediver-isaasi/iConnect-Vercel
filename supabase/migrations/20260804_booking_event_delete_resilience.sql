-- Task #3344: Fix event delete FK failure on bookings.
--
-- 1. Snapshot column: booking / complex_event_booking get `event_name` so
--    cancelled-booking history stays readable after the event row is
--    hard-deleted (event_id is cleared at delete time). Named `event_name`
--    because existing client surfaces (History.jsx, Bookings.jsx,
--    EventRegistrationReport.jsx) already fall back to `booking.event_name`.
--
-- 2. booking_event_id_fkey currently has no ON DELETE behaviour (NO ACTION),
--    so deleting an event that ever had a booking always fails and leaves the
--    event stuck in 'cancelling'. Recreate it as ON DELETE SET NULL as a
--    belt-and-braces guard (the app also detaches bookings explicitly before
--    deleting the event).
--
-- Note: complex_event_booking.event_id has NO foreign key to complex_event at
-- all (verified in DEST), so there is no constraint to alter there.

ALTER TABLE booking ADD COLUMN IF NOT EXISTS event_name text;
ALTER TABLE complex_event_booking ADD COLUMN IF NOT EXISTS event_name text;

-- event_id must be nullable so detached (deleted-event) bookings can persist.
ALTER TABLE booking ALTER COLUMN event_id DROP NOT NULL;
ALTER TABLE complex_event_booking ALTER COLUMN event_id DROP NOT NULL;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'booking_event_id_fkey' AND table_name = 'booking'
  ) THEN
    ALTER TABLE booking DROP CONSTRAINT booking_event_id_fkey;
  END IF;
  ALTER TABLE booking
    ADD CONSTRAINT booking_event_id_fkey
    FOREIGN KEY (event_id) REFERENCES event(id) ON DELETE SET NULL;
END $$;
