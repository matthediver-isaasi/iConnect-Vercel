-- Add revert_trigger_on_condition_fail to workflow table
-- When true, if workflow conditions are not met, the triggering field
-- is reverted to its pre-change value
ALTER TABLE workflow
ADD COLUMN IF NOT EXISTS revert_trigger_on_condition_fail boolean DEFAULT false;
