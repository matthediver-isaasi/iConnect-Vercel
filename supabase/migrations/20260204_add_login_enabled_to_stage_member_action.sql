-- Migration: Add login_enabled column to stage_member_action table
-- Allows configuration of whether members created via stage actions should have login enabled
-- Run this SQL in your Supabase SQL Editor

-- Step 1: Add login_enabled column (defaults to false for backwards compatibility)
ALTER TABLE stage_member_action 
ADD COLUMN IF NOT EXISTS login_enabled BOOLEAN DEFAULT false;

-- Step 2: Add comment for documentation
COMMENT ON COLUMN stage_member_action.login_enabled IS 'Whether members created by this action should have login access enabled';

-- Verify migration
SELECT 
  column_name, 
  data_type, 
  column_default 
FROM information_schema.columns 
WHERE table_name = 'stage_member_action' 
AND column_name = 'login_enabled';
