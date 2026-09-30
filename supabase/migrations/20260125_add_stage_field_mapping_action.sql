-- Migration: Add field mapping actions to due diligence workflow stages
-- Creates stage_field_mapping_action table for mapping form fields to organization fields when stages are selected
-- Run this SQL in your Supabase SQL Editor

-- Step 1: Create stage_field_mapping_action table
-- Stores field mapping configurations per due diligence stage
CREATE TABLE IF NOT EXISTS stage_field_mapping_action (
  id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid()::text,
  tenant_id UUID NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  due_diligence_stage_id VARCHAR NOT NULL,
  
  -- Field mappings: array of { source_field_id, target_type, target_field }
  -- source_field_id: form field ID from the DD form
  -- target_type: 'core' or 'custom'
  -- target_field: core field name (e.g., 'name', 'email') or custom field ID (UUID)
  field_mappings JSONB NOT NULL DEFAULT '[]',
  
  -- Display order for multiple mapping actions per stage
  sort_order INTEGER DEFAULT 0,
  is_active BOOLEAN DEFAULT true,
  
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Step 2: Create indexes for performance
CREATE INDEX IF NOT EXISTS idx_stage_field_mapping_action_tenant ON stage_field_mapping_action(tenant_id);
CREATE INDEX IF NOT EXISTS idx_stage_field_mapping_action_stage ON stage_field_mapping_action(due_diligence_stage_id);

-- Step 3: Enable RLS
ALTER TABLE stage_field_mapping_action ENABLE ROW LEVEL SECURITY;

-- Step 4: RLS policies (allow service role full access)
DROP POLICY IF EXISTS "Service role has full access to stage_field_mapping_action" ON stage_field_mapping_action;
CREATE POLICY "Service role has full access to stage_field_mapping_action" ON stage_field_mapping_action
  FOR ALL USING (true) WITH CHECK (true);

-- Step 5: Create trigger for updated_at
CREATE OR REPLACE FUNCTION update_stage_field_mapping_action_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_stage_field_mapping_action_updated_at ON stage_field_mapping_action;
CREATE TRIGGER trigger_stage_field_mapping_action_updated_at
  BEFORE UPDATE ON stage_field_mapping_action
  FOR EACH ROW
  EXECUTE FUNCTION update_stage_field_mapping_action_updated_at();

-- Verify migration
SELECT 
  'stage_field_mapping_action' as table_name, 
  COUNT(*) as record_count 
FROM stage_field_mapping_action;
