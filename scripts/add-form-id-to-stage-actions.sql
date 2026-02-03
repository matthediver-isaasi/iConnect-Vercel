-- Migration: Add form_id column to stage action tables
-- This enables form-specific scoping for stage actions
-- Run this in Supabase SQL Editor

-- Add form_id to stage_member_action table
ALTER TABLE stage_member_action 
ADD COLUMN IF NOT EXISTS form_id uuid REFERENCES form(id) ON DELETE SET NULL;

-- Add form_id to stage_field_mapping_action table  
ALTER TABLE stage_field_mapping_action 
ADD COLUMN IF NOT EXISTS form_id uuid REFERENCES form(id) ON DELETE SET NULL;

-- Create indexes for efficient querying by form_id
CREATE INDEX IF NOT EXISTS idx_stage_member_action_form_id 
ON stage_member_action(form_id);

CREATE INDEX IF NOT EXISTS idx_stage_field_mapping_action_form_id 
ON stage_field_mapping_action(form_id);

-- Optional: Update existing records to associate with their form
-- This uses the relationship: stage action -> due_diligence_stage -> due_diligence_config -> form_id
-- Run this after adding the column to backfill existing data

UPDATE stage_member_action sma
SET form_id = ddc.form_id
FROM due_diligence_stage dds
JOIN due_diligence_config ddc ON dds.due_diligence_config_id = ddc.id
WHERE sma.due_diligence_stage_id = dds.id
AND sma.form_id IS NULL;

UPDATE stage_field_mapping_action sfma
SET form_id = ddc.form_id
FROM due_diligence_stage dds
JOIN due_diligence_config ddc ON dds.due_diligence_config_id = ddc.id
WHERE sfma.due_diligence_stage_id = dds.id
AND sfma.form_id IS NULL;
