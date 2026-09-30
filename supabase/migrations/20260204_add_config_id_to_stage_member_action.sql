-- Migration: Add form_due_diligence_config_id to stage_member_action table
-- This ensures member actions are scoped to a specific form's DD config,
-- preventing cross-form action execution when stage IDs are the same (e.g., "approved")
-- Run this SQL in your Supabase SQL Editor

-- Step 1: Add form_due_diligence_config_id column
ALTER TABLE stage_member_action
ADD COLUMN IF NOT EXISTS form_due_diligence_config_id UUID REFERENCES form_due_diligence_config(id) ON DELETE CASCADE;

-- Step 2: Create index for performance
CREATE INDEX IF NOT EXISTS idx_stage_member_action_config ON stage_member_action(form_due_diligence_config_id);

-- Step 3: Backfill existing records - link to DD config via form_id
-- This preserves existing member actions by properly scoping them
-- Note: sma.form_id is VARCHAR, fddc.form_id is UUID - cast both to text for comparison
UPDATE stage_member_action sma
SET form_due_diligence_config_id = (
  SELECT fddc.id 
  FROM form_due_diligence_config fddc 
  WHERE fddc.form_id::text = sma.form_id::text 
    AND fddc.tenant_id = sma.tenant_id
  LIMIT 1
)
WHERE sma.form_due_diligence_config_id IS NULL
  AND sma.form_id IS NOT NULL;

-- Step 4: Verify migration
SELECT 
  'stage_member_action config_id column' as migration_check,
  column_name,
  data_type
FROM information_schema.columns 
WHERE table_name = 'stage_member_action' 
  AND column_name = 'form_due_diligence_config_id';

-- Show backfill results
SELECT 
  'Backfill results' as check_name,
  COUNT(*) FILTER (WHERE form_due_diligence_config_id IS NOT NULL) as with_config_id,
  COUNT(*) FILTER (WHERE form_due_diligence_config_id IS NULL) as without_config_id
FROM stage_member_action;
