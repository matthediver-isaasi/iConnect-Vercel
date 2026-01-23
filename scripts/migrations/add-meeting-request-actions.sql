-- Migration: Add meeting request actions to due diligence workflow stages
-- Adds email_template_id to meeting_template for invitation emails
-- Creates stage_meeting_request table for stage configurations
-- Run this SQL in your Supabase SQL Editor

-- Step 1: Add email_template_id to meeting_template for invitation email
ALTER TABLE meeting_template ADD COLUMN IF NOT EXISTS email_template_id VARCHAR REFERENCES email_template(id) ON DELETE SET NULL;

-- Step 2: Create stage_meeting_request table
-- Stores meeting request configurations per due diligence stage
CREATE TABLE IF NOT EXISTS stage_meeting_request (
  id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid()::text,
  tenant_id UUID NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  due_diligence_stage_id VARCHAR NOT NULL REFERENCES due_diligence_stage(id) ON DELETE CASCADE,
  meeting_template_id VARCHAR NOT NULL REFERENCES meeting_template(id) ON DELETE CASCADE,
  
  -- Field mappings from form submission
  recipient_email_field VARCHAR NOT NULL,
  first_name_field VARCHAR,
  
  -- Display order for multiple meeting requests per stage
  sort_order INTEGER DEFAULT 0,
  is_active BOOLEAN DEFAULT true,
  
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Step 3: Create indexes for performance
CREATE INDEX IF NOT EXISTS idx_meeting_template_email_template ON meeting_template(email_template_id);
CREATE INDEX IF NOT EXISTS idx_stage_meeting_request_tenant ON stage_meeting_request(tenant_id);
CREATE INDEX IF NOT EXISTS idx_stage_meeting_request_stage ON stage_meeting_request(due_diligence_stage_id);
CREATE INDEX IF NOT EXISTS idx_stage_meeting_request_template ON stage_meeting_request(meeting_template_id);

-- Step 4: Enable RLS
ALTER TABLE stage_meeting_request ENABLE ROW LEVEL SECURITY;

-- Step 5: RLS policies (allow service role full access)
DROP POLICY IF EXISTS "Service role has full access to stage_meeting_request" ON stage_meeting_request;
CREATE POLICY "Service role has full access to stage_meeting_request" ON stage_meeting_request
  FOR ALL USING (true) WITH CHECK (true);

-- Step 6: Create trigger for updated_at
CREATE OR REPLACE FUNCTION update_stage_meeting_request_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_stage_meeting_request_updated_at ON stage_meeting_request;
CREATE TRIGGER trigger_stage_meeting_request_updated_at
  BEFORE UPDATE ON stage_meeting_request
  FOR EACH ROW
  EXECUTE FUNCTION update_stage_meeting_request_updated_at();

-- Verify migration
SELECT 
  'stage_meeting_request' as table_name, 
  COUNT(*) as record_count 
FROM stage_meeting_request;
