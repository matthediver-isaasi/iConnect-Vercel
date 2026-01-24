-- Migration: Add member creation actions to due diligence workflow stages
-- Creates stage_member_action table for creating member records when stages are selected
-- Run this SQL in your Supabase SQL Editor

-- Step 1: Create stage_member_action table
-- Stores member creation action configurations per due diligence stage
CREATE TABLE IF NOT EXISTS stage_member_action (
  id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid()::text,
  tenant_id UUID NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  due_diligence_stage_id VARCHAR NOT NULL,
  
  -- Mandatory field mappings from form submission (form field IDs)
  first_name_field VARCHAR NOT NULL,
  last_name_field VARCHAR NOT NULL,
  email_field VARCHAR NOT NULL,
  
  -- Field mappings for core and custom member fields
  -- Structure: { "core": { "mobile": { "source": "form_field", "value": "field_id" } | { "source": "manual", "value": "static value" } }, 
  --              "custom": { "pref_field_id": { "source": "form_field", "value": "field_id" } | { "source": "manual", "value": "static value" } } }
  field_mappings JSONB DEFAULT '{"core": {}, "custom": {}}'::jsonb,
  
  -- Role to assign to new members (optional - uses default role if not specified)
  role_id UUID REFERENCES role(id) ON DELETE SET NULL,
  
  -- Whether to send welcome email to new member
  send_welcome_email BOOLEAN DEFAULT false,
  
  -- Display order for multiple member actions per stage
  sort_order INTEGER DEFAULT 0,
  is_active BOOLEAN DEFAULT true,
  
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Step 2: Create indexes for performance
CREATE INDEX IF NOT EXISTS idx_stage_member_action_tenant ON stage_member_action(tenant_id);
CREATE INDEX IF NOT EXISTS idx_stage_member_action_stage ON stage_member_action(due_diligence_stage_id);

-- Step 3: Enable RLS
ALTER TABLE stage_member_action ENABLE ROW LEVEL SECURITY;

-- Step 4: RLS policies (allow service role full access)
DROP POLICY IF EXISTS "Service role has full access to stage_member_action" ON stage_member_action;
CREATE POLICY "Service role has full access to stage_member_action" ON stage_member_action
  FOR ALL USING (true) WITH CHECK (true);

-- Step 5: Create trigger for updated_at
CREATE OR REPLACE FUNCTION update_stage_member_action_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_stage_member_action_updated_at ON stage_member_action;
CREATE TRIGGER trigger_stage_member_action_updated_at
  BEFORE UPDATE ON stage_member_action
  FOR EACH ROW
  EXECUTE FUNCTION update_stage_member_action_updated_at();

-- Verify migration
SELECT 
  'stage_member_action' as table_name, 
  COUNT(*) as record_count 
FROM stage_member_action;
