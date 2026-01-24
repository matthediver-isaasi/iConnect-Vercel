-- Migration: Add allow_swap default to existing workflow stages
-- This migration updates existing dd_config records to add allow_swap: true
-- to all workflow stages that don't already have this property set.
-- This ensures backwards compatibility where all existing stages allow swapping.

-- Update all workflow_stages arrays to add allow_swap: true to each stage
-- that doesn't already have an allow_swap property
UPDATE dd_config
SET workflow_stages = (
  SELECT jsonb_agg(
    CASE 
      WHEN stage ? 'allow_swap' THEN stage
      ELSE stage || '{"allow_swap": true}'::jsonb
    END
  )
  FROM jsonb_array_elements(workflow_stages) AS stage
)
WHERE workflow_stages IS NOT NULL 
  AND jsonb_array_length(workflow_stages) > 0;

-- Add a comment for documentation
COMMENT ON COLUMN dd_config.workflow_stages IS 'Array of workflow stages. Each stage can have allow_swap (boolean, default true) to control whether form swapping is permitted at that stage.';
