-- Migration: Add form_id column to stage action tables
-- This enables form-specific scoping for stage actions
-- Run this in Supabase SQL Editor

-- Step 1: Add form_id column to stage_member_action table
ALTER TABLE stage_member_action 
ADD COLUMN IF NOT EXISTS form_id uuid REFERENCES form(id) ON DELETE SET NULL;

-- Step 2: Add form_id column to stage_field_mapping_action table  
ALTER TABLE stage_field_mapping_action 
ADD COLUMN IF NOT EXISTS form_id uuid REFERENCES form(id) ON DELETE SET NULL;

-- Step 3: Create indexes for efficient querying by form_id
CREATE INDEX IF NOT EXISTS idx_stage_member_action_form_id 
ON stage_member_action(form_id);

CREATE INDEX IF NOT EXISTS idx_stage_field_mapping_action_form_id 
ON stage_field_mapping_action(form_id);

-- After running the above, new actions will be properly scoped to their form.
-- Existing actions without form_id will still show up until you either:
-- 1. Delete and recreate them (they'll get the proper form_id)
-- 2. Or manually update them with the correct form_id
