-- Add segment_values column to role table for role segmentation feature
-- Run this script in your Supabase SQL Editor to enable role segmentation by organization type

-- Add segment_values column to role table
-- This stores an array of organization custom field values that the role applies to
-- NULL means the role applies to all organizations (backward compatible)
-- Empty array [] means the role is not applicable to any specific segment
ALTER TABLE role ADD COLUMN IF NOT EXISTS segment_values TEXT[];

-- Create index for querying roles by segment values
CREATE INDEX IF NOT EXISTS idx_role_segment_values ON role USING GIN (segment_values);

-- Verify the column was added
SELECT column_name, data_type, is_nullable 
FROM information_schema.columns 
WHERE table_name = 'role' AND column_name = 'segment_values';
