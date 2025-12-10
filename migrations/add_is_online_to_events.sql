-- Migration: Add is_online boolean column to events table
-- Run this SQL on your production Supabase database
-- This column tracks whether an event is an online event or in-person event

-- Step 1: Add the is_online column with default value of false
ALTER TABLE events 
ADD COLUMN IF NOT EXISTS is_online BOOLEAN DEFAULT FALSE;

-- Step 2: Migrate existing events - set is_online to true for events that appear to be online
-- This is based on the location field containing 'online', 'zoom.us', or 'https://'
UPDATE events 
SET is_online = TRUE 
WHERE is_online IS NULL 
  AND (
    LOWER(location) LIKE '%online%' 
    OR location LIKE '%zoom.us%' 
    OR location LIKE 'https://%'
  );

-- Step 3: Set remaining NULL values to false (in-person events)
UPDATE events 
SET is_online = FALSE 
WHERE is_online IS NULL;

-- Verification query (optional) - run to check the results
-- SELECT id, title, location, is_online FROM events ORDER BY start_date DESC LIMIT 20;
