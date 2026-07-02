-- Migration: Add form_id column to stage_email_action table
-- This allows email actions to be scoped per form, not just per stage
-- Run this SQL in your Supabase SQL Editor

-- Step 1: Add form_id column (nullable initially to not break existing data)
ALTER TABLE stage_email_action 
ADD COLUMN IF NOT EXISTS form_id UUID REFERENCES form(id) ON DELETE CASCADE;

-- Step 2: Create index for performance
CREATE INDEX IF NOT EXISTS idx_stage_email_action_form ON stage_email_action(form_id);

-- Step 3: Create composite index for the common query pattern
CREATE INDEX IF NOT EXISTS idx_stage_email_action_stage_form ON stage_email_action(due_diligence_stage_id, form_id);

-- Verify migration
SELECT 
  column_name, 
  data_type, 
  is_nullable
FROM information_schema.columns 
WHERE table_name = 'stage_email_action' 
AND column_name = 'form_id';
