-- Migration: Add DD Meeting Request tracking table
-- Tracks meeting invitations sent from Due Diligence workflow stages
-- Similar pattern to contract signatories - supports pending/booked status, resend, and alternatives
-- Run this SQL in your Supabase SQL Editor

-- Step 1: Create dd_meeting_request table
-- Stores individual meeting request invitations linked to DD submissions
CREATE TABLE IF NOT EXISTS dd_meeting_request (
  id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid()::text,
  tenant_id UUID NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  
  -- Link to the DD submission (form_submission)
  form_submission_id VARCHAR NOT NULL,
  
  -- Link to the stage meeting request config that triggered this
  stage_meeting_request_id VARCHAR REFERENCES stage_meeting_request(id) ON DELETE SET NULL,
  
  -- Meeting template used
  meeting_template_id VARCHAR NOT NULL REFERENCES meeting_template(id) ON DELETE CASCADE,
  
  -- Agent who will host the meeting
  agent_identity_id VARCHAR NOT NULL REFERENCES tenant_identity(id) ON DELETE CASCADE,
  
  -- Recipient information (from form submission fields)
  recipient_email VARCHAR NOT NULL,
  recipient_first_name VARCHAR,
  recipient_last_name VARCHAR,
  
  -- Status tracking: pending, booked, expired, cancelled
  status VARCHAR NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'booked', 'expired', 'cancelled')),
  
  -- Linked booking when status = 'booked' (first-past-the-post winner)
  agent_booking_id VARCHAR REFERENCES agent_booking(id) ON DELETE SET NULL,
  
  -- Email sending tracking
  sent_at TIMESTAMP WITH TIME ZONE,
  last_resent_at TIMESTAMP WITH TIME ZONE,
  resend_count INTEGER DEFAULT 0,
  
  -- The booking URL that was sent
  booking_url VARCHAR,
  
  -- Whether this is the original request or an alternative
  is_original BOOLEAN DEFAULT true,
  
  -- Optional notes
  notes TEXT,
  
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Step 2: Create indexes for performance
CREATE INDEX IF NOT EXISTS idx_dd_meeting_request_tenant ON dd_meeting_request(tenant_id);
CREATE INDEX IF NOT EXISTS idx_dd_meeting_request_submission ON dd_meeting_request(form_submission_id);
CREATE INDEX IF NOT EXISTS idx_dd_meeting_request_stage_config ON dd_meeting_request(stage_meeting_request_id);
CREATE INDEX IF NOT EXISTS idx_dd_meeting_request_template ON dd_meeting_request(meeting_template_id);
CREATE INDEX IF NOT EXISTS idx_dd_meeting_request_agent ON dd_meeting_request(agent_identity_id);
CREATE INDEX IF NOT EXISTS idx_dd_meeting_request_status ON dd_meeting_request(status);
CREATE INDEX IF NOT EXISTS idx_dd_meeting_request_recipient_email ON dd_meeting_request(recipient_email);
CREATE INDEX IF NOT EXISTS idx_dd_meeting_request_booking ON dd_meeting_request(agent_booking_id);

-- Step 3: Enable RLS
ALTER TABLE dd_meeting_request ENABLE ROW LEVEL SECURITY;

-- Step 4: RLS policies (allow service role full access)
DROP POLICY IF EXISTS "Service role has full access to dd_meeting_request" ON dd_meeting_request;
CREATE POLICY "Service role has full access to dd_meeting_request" ON dd_meeting_request
  FOR ALL USING (true) WITH CHECK (true);

-- Step 5: Create trigger for updated_at
CREATE OR REPLACE FUNCTION update_dd_meeting_request_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_dd_meeting_request_updated_at ON dd_meeting_request;
CREATE TRIGGER trigger_dd_meeting_request_updated_at
  BEFORE UPDATE ON dd_meeting_request
  FOR EACH ROW
  EXECUTE FUNCTION update_dd_meeting_request_updated_at();

-- Step 6: Add form_submission_id to agent_booking for linking DD requests
-- This allows us to link bookings back to DD submissions for first-past-the-post detection
ALTER TABLE agent_booking ADD COLUMN IF NOT EXISTS form_submission_id VARCHAR;
CREATE INDEX IF NOT EXISTS idx_agent_booking_form_submission ON agent_booking(form_submission_id);

-- Verify migration
SELECT 
  'dd_meeting_request' as table_name, 
  COUNT(*) as record_count 
FROM dd_meeting_request;
