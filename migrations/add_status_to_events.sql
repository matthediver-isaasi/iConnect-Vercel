-- Migration: Add status field to events table
-- Run this SQL on your production Supabase database
-- This column tracks the event status: draft, published, or tbc (to be confirmed)

-- Step 1: Add the status column with default value of 'published'
ALTER TABLE events 
ADD COLUMN IF NOT EXISTS status VARCHAR(20) DEFAULT 'published';

-- Step 2: Set all existing events to 'published' (maintaining backwards compatibility)
UPDATE events 
SET status = 'published' 
WHERE status IS NULL;

-- Add a check constraint to ensure valid status values
DO $$ 
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'events_status_check'
  ) THEN
    ALTER TABLE events 
    ADD CONSTRAINT events_status_check 
    CHECK (status IN ('draft', 'published', 'tbc'));
  END IF;
END $$;

-- Verification query (optional) - run to check the results
-- SELECT id, title, status FROM events ORDER BY start_date DESC LIMIT 20;
