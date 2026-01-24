-- Migration: Add email template actions to due diligence workflow stages
-- Creates stage_email_action table for sending email templates when stages are selected
-- Run this SQL in your Supabase SQL Editor

-- Step 1: Create stage_email_action table
-- Stores email template action configurations per due diligence stage
-- Note: due_diligence_stage_id is a string ID from the workflow_stages JSON, not a foreign key
CREATE TABLE IF NOT EXISTS stage_email_action (
  id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid()::text,
  tenant_id UUID NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  due_diligence_stage_id VARCHAR NOT NULL,
  email_template_id UUID NOT NULL REFERENCES email_template(id) ON DELETE CASCADE,
  
  -- Field mappings from form submission
  recipient_email_field VARCHAR NOT NULL,
  recipient_name_field VARCHAR,
  
  -- Optional manual CC recipients (comma-separated emails)
  cc_emails VARCHAR,
  
  -- Custom message to insert via {{custom_message}} placeholder
  custom_message TEXT,
  
  -- Display order for multiple email actions per stage
  sort_order INTEGER DEFAULT 0,
  is_active BOOLEAN DEFAULT true,
  
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Step 2: Create indexes for performance
CREATE INDEX IF NOT EXISTS idx_stage_email_action_tenant ON stage_email_action(tenant_id);
CREATE INDEX IF NOT EXISTS idx_stage_email_action_stage ON stage_email_action(due_diligence_stage_id);
CREATE INDEX IF NOT EXISTS idx_stage_email_action_template ON stage_email_action(email_template_id);

-- Step 3: Enable RLS
ALTER TABLE stage_email_action ENABLE ROW LEVEL SECURITY;

-- Step 4: RLS policies (allow service role full access)
DROP POLICY IF EXISTS "Service role has full access to stage_email_action" ON stage_email_action;
CREATE POLICY "Service role has full access to stage_email_action" ON stage_email_action
  FOR ALL USING (true) WITH CHECK (true);

-- Step 5: Create trigger for updated_at
CREATE OR REPLACE FUNCTION update_stage_email_action_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_stage_email_action_updated_at ON stage_email_action;
CREATE TRIGGER trigger_stage_email_action_updated_at
  BEFORE UPDATE ON stage_email_action
  FOR EACH ROW
  EXECUTE FUNCTION update_stage_email_action_updated_at();

-- Verify migration
SELECT 
  'stage_email_action' as table_name, 
  COUNT(*) as record_count 
FROM stage_email_action;
