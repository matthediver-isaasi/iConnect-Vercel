-- Task #1250: Dietary, accessibility & allergy options on events.
--
-- Admin-defined option lists live on the event / complex_event rows. Each is a
-- JSONB array of strings (e.g. ["Vegetarian", "Vegan"]). Allergies are a
-- subsection of Dietary but stored as their own list for clarity.
ALTER TABLE event ADD COLUMN IF NOT EXISTS dietary_options JSONB;
ALTER TABLE event ADD COLUMN IF NOT EXISTS allergy_options JSONB;
ALTER TABLE event ADD COLUMN IF NOT EXISTS accessibility_options JSONB;

ALTER TABLE complex_event ADD COLUMN IF NOT EXISTS dietary_options JSONB;
ALTER TABLE complex_event ADD COLUMN IF NOT EXISTS allergy_options JSONB;
ALTER TABLE complex_event ADD COLUMN IF NOT EXISTS accessibility_options JSONB;

-- Per-attendee selections live on the booking rows.
--   dietary_selections       : JSONB array of strings
--   accessibility_selections : JSONB array of strings
--   allergy_selections       : JSONB array of { name, severity } where
--                              severity is one of 'mild' | 'moderate' | 'severe'
ALTER TABLE booking ADD COLUMN IF NOT EXISTS dietary_selections JSONB;
ALTER TABLE booking ADD COLUMN IF NOT EXISTS allergy_selections JSONB;
ALTER TABLE booking ADD COLUMN IF NOT EXISTS accessibility_selections JSONB;

ALTER TABLE complex_event_booking ADD COLUMN IF NOT EXISTS dietary_selections JSONB;
ALTER TABLE complex_event_booking ADD COLUMN IF NOT EXISTS allergy_selections JSONB;
ALTER TABLE complex_event_booking ADD COLUMN IF NOT EXISTS accessibility_selections JSONB;
