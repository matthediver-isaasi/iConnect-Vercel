-- Add is_unlimited_registration column to event table
-- This explicitly indicates whether an event has unlimited/open registration
-- When true: no seat limit (available_seats is ignored)
-- When false/null: use available_seats to track capacity (0 means sold out)

ALTER TABLE event 
ADD COLUMN IF NOT EXISTS is_unlimited_registration boolean DEFAULT false;

-- Migrate existing data: events with null available_seats should be unlimited
UPDATE event 
SET is_unlimited_registration = true 
WHERE available_seats IS NULL;

-- Also migrate legacy data: events with available_seats = 0 AND no seat_capacity set
-- These were previously treated as "unlimited" in the old logic
UPDATE event 
SET is_unlimited_registration = true 
WHERE available_seats = 0 
  AND (seat_capacity IS NULL OR seat_capacity = 0)
  AND is_unlimited_registration = false;

-- Add comment for documentation
COMMENT ON COLUMN event.is_unlimited_registration IS 'If true, event has no seat limit (open registration). If false/null, use available_seats to track capacity.';
