-- TBC booking replacement follow-ups: optional "Booking summary title"
-- override shown in place of the "Booking Summary" card heading while the
-- replacement display is active.
ALTER TABLE event ADD COLUMN IF NOT EXISTS booking_replacement_title text;
ALTER TABLE complex_event ADD COLUMN IF NOT EXISTS booking_replacement_title text;
