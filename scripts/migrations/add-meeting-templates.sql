-- Migration: Add meeting templates and agent assignments for booking system
-- All tables are tenant-scoped for multi-tenant isolation
-- Run this SQL in your Supabase SQL Editor

-- Step 1: Create meeting_template table
CREATE TABLE IF NOT EXISTS meeting_template (
  id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid()::text,
  tenant_id UUID NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  
  -- Template identification
  slug VARCHAR NOT NULL,
  name VARCHAR NOT NULL,
  description TEXT,
  
  -- Meeting configuration
  duration_minutes INTEGER NOT NULL DEFAULT 30,
  meeting_type VARCHAR NOT NULL DEFAULT 'phone' CHECK (meeting_type IN ('phone', 'google_meet', 'in_person')),
  
  -- Optional settings
  is_active BOOLEAN DEFAULT true,
  buffer_before_minutes INTEGER DEFAULT 0,
  buffer_after_minutes INTEGER DEFAULT 0,
  
  -- Display order
  sort_order INTEGER DEFAULT 0,
  
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  
  -- Ensure slug is unique per tenant
  UNIQUE(tenant_id, slug)
);

-- Step 2: Create agent_meeting_template join table
-- Links agents (tenant_identity) to meeting templates they can offer
CREATE TABLE IF NOT EXISTS agent_meeting_template (
  id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid()::text,
  tenant_id UUID NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  identity_id VARCHAR NOT NULL REFERENCES tenant_identity(id) ON DELETE CASCADE,
  meeting_template_id VARCHAR NOT NULL REFERENCES meeting_template(id) ON DELETE CASCADE,
  
  -- Optional agent-specific overrides
  custom_duration_minutes INTEGER,
  is_active BOOLEAN DEFAULT true,
  
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  
  -- Prevent duplicate assignments
  UNIQUE(tenant_id, identity_id, meeting_template_id)
);

-- Step 3: Add is_booking_agent flag to tenant_identity if not exists
ALTER TABLE tenant_identity ADD COLUMN IF NOT EXISTS is_booking_agent BOOLEAN DEFAULT false;

-- Step 4: Add meeting_template_id to agent_booking to track which template was used
ALTER TABLE agent_booking ADD COLUMN IF NOT EXISTS meeting_template_id VARCHAR REFERENCES meeting_template(id);
ALTER TABLE agent_booking ADD COLUMN IF NOT EXISTS meeting_type VARCHAR DEFAULT 'phone';

-- Step 5: Create indexes for performance
CREATE INDEX IF NOT EXISTS idx_meeting_template_tenant ON meeting_template(tenant_id);
CREATE INDEX IF NOT EXISTS idx_meeting_template_active ON meeting_template(tenant_id, is_active);
CREATE INDEX IF NOT EXISTS idx_meeting_template_slug ON meeting_template(tenant_id, slug);

CREATE INDEX IF NOT EXISTS idx_agent_meeting_template_tenant ON agent_meeting_template(tenant_id);
CREATE INDEX IF NOT EXISTS idx_agent_meeting_template_identity ON agent_meeting_template(identity_id);
CREATE INDEX IF NOT EXISTS idx_agent_meeting_template_template ON agent_meeting_template(meeting_template_id);

CREATE INDEX IF NOT EXISTS idx_tenant_identity_booking_agent ON tenant_identity(is_booking_agent) WHERE is_booking_agent = true;

CREATE INDEX IF NOT EXISTS idx_agent_booking_template ON agent_booking(meeting_template_id);

-- Step 6: Enable RLS
ALTER TABLE meeting_template ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_meeting_template ENABLE ROW LEVEL SECURITY;

-- Step 7: RLS policies (allow service role full access)
DROP POLICY IF EXISTS "Service role has full access to meeting_template" ON meeting_template;
DROP POLICY IF EXISTS "Service role has full access to agent_meeting_template" ON agent_meeting_template;

CREATE POLICY "Service role has full access to meeting_template" ON meeting_template
  FOR ALL USING (true) WITH CHECK (true);

CREATE POLICY "Service role has full access to agent_meeting_template" ON agent_meeting_template
  FOR ALL USING (true) WITH CHECK (true);

-- Step 8: Create triggers for updated_at
CREATE OR REPLACE FUNCTION update_meeting_template_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_meeting_template_updated_at ON meeting_template;
CREATE TRIGGER trigger_meeting_template_updated_at
  BEFORE UPDATE ON meeting_template
  FOR EACH ROW
  EXECUTE FUNCTION update_meeting_template_updated_at();

-- Verify migration
SELECT 
  'meeting_template' as table_name, 
  COUNT(*) as record_count 
FROM meeting_template
UNION ALL
SELECT 
  'agent_meeting_template' as table_name, 
  COUNT(*) as record_count 
FROM agent_meeting_template;
