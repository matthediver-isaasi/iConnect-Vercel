-- Migration: Add agent booking system tables
-- Enables personal booking links for agents (Super Users) to share availability
-- Run this SQL in your Supabase SQL Editor

-- Step 1: Add booking_slug column to tenant_identity for unique booking URLs
ALTER TABLE tenant_identity ADD COLUMN IF NOT EXISTS booking_slug VARCHAR UNIQUE;

-- Step 2: Create agent_availability_profile table (stores working hours per agent)
CREATE TABLE IF NOT EXISTS agent_availability_profile (
  id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid()::text,
  tenant_id UUID NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  identity_id VARCHAR NOT NULL REFERENCES tenant_identity(id) ON DELETE CASCADE,
  
  -- Availability settings
  is_active BOOLEAN DEFAULT true,
  timezone VARCHAR NOT NULL DEFAULT 'Europe/London',
  default_slot_minutes INTEGER DEFAULT 30,
  buffer_minutes INTEGER DEFAULT 0,
  
  -- Working hours (JSON array for each day)
  -- Format: {"monday": [{"start": "09:00", "end": "17:00"}], "tuesday": [...], ...}
  working_hours JSONB DEFAULT '{
    "monday": [{"start": "09:00", "end": "17:00"}],
    "tuesday": [{"start": "09:00", "end": "17:00"}],
    "wednesday": [{"start": "09:00", "end": "17:00"}],
    "thursday": [{"start": "09:00", "end": "17:00"}],
    "friday": [{"start": "09:00", "end": "17:00"}],
    "saturday": [],
    "sunday": []
  }',
  
  -- Booking page settings
  booking_title VARCHAR DEFAULT 'Book a Meeting',
  booking_description TEXT,
  
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  
  UNIQUE(tenant_id, identity_id)
);

-- Step 3: Create agent_booking table (stores booked meetings)
CREATE TABLE IF NOT EXISTS agent_booking (
  id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid()::text,
  tenant_id UUID NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  identity_id VARCHAR NOT NULL REFERENCES tenant_identity(id) ON DELETE CASCADE,
  
  -- Attendee information
  attendee_name VARCHAR NOT NULL,
  attendee_email VARCHAR NOT NULL,
  attendee_phone VARCHAR,
  attendee_timezone VARCHAR DEFAULT 'Europe/London',
  attendee_notes TEXT,
  
  -- Meeting details
  title VARCHAR DEFAULT 'Meeting',
  starts_at TIMESTAMP WITH TIME ZONE NOT NULL,
  ends_at TIMESTAMP WITH TIME ZONE NOT NULL,
  duration_minutes INTEGER NOT NULL DEFAULT 30,
  
  -- Status tracking
  status VARCHAR DEFAULT 'confirmed', -- 'pending', 'confirmed', 'cancelled', 'completed'
  cancellation_reason TEXT,
  cancelled_at TIMESTAMP WITH TIME ZONE,
  cancelled_by VARCHAR, -- 'agent' or 'attendee'
  
  -- Optional link to member record
  member_id VARCHAR,
  
  -- Meeting link (if online)
  meeting_url VARCHAR,
  
  -- Tracking
  confirmation_sent_at TIMESTAMP WITH TIME ZONE,
  reminder_sent_at TIMESTAMP WITH TIME ZONE,
  
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Step 4: Create indexes for performance
CREATE INDEX IF NOT EXISTS idx_tenant_identity_booking_slug ON tenant_identity(booking_slug);

CREATE INDEX IF NOT EXISTS idx_agent_availability_tenant ON agent_availability_profile(tenant_id);
CREATE INDEX IF NOT EXISTS idx_agent_availability_identity ON agent_availability_profile(identity_id);
CREATE INDEX IF NOT EXISTS idx_agent_availability_active ON agent_availability_profile(is_active);

CREATE INDEX IF NOT EXISTS idx_agent_booking_tenant ON agent_booking(tenant_id);
CREATE INDEX IF NOT EXISTS idx_agent_booking_identity ON agent_booking(identity_id);
CREATE INDEX IF NOT EXISTS idx_agent_booking_starts ON agent_booking(starts_at);
CREATE INDEX IF NOT EXISTS idx_agent_booking_status ON agent_booking(status);
CREATE INDEX IF NOT EXISTS idx_agent_booking_attendee_email ON agent_booking(attendee_email);
CREATE INDEX IF NOT EXISTS idx_agent_booking_member ON agent_booking(member_id);

-- Step 5: Enable RLS
ALTER TABLE agent_availability_profile ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_booking ENABLE ROW LEVEL SECURITY;

-- Step 6: RLS policies (allow service role full access)
DROP POLICY IF EXISTS "Service role has full access to agent_availability_profile" ON agent_availability_profile;
DROP POLICY IF EXISTS "Service role has full access to agent_booking" ON agent_booking;

CREATE POLICY "Service role has full access to agent_availability_profile" ON agent_availability_profile
  FOR ALL USING (true) WITH CHECK (true);

CREATE POLICY "Service role has full access to agent_booking" ON agent_booking
  FOR ALL USING (true) WITH CHECK (true);

-- Step 7: Create triggers for updated_at
DROP TRIGGER IF EXISTS trigger_agent_availability_updated_at ON agent_availability_profile;
DROP TRIGGER IF EXISTS trigger_agent_booking_updated_at ON agent_booking;

CREATE OR REPLACE FUNCTION update_agent_availability_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_agent_availability_updated_at
  BEFORE UPDATE ON agent_availability_profile
  FOR EACH ROW
  EXECUTE FUNCTION update_agent_availability_updated_at();

CREATE OR REPLACE FUNCTION update_agent_booking_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_agent_booking_updated_at
  BEFORE UPDATE ON agent_booking
  FOR EACH ROW
  EXECUTE FUNCTION update_agent_booking_updated_at();

-- Step 8: Generate booking slugs for existing users
-- Creates slugs from first_name-last_name format, with collision handling
DO $$
DECLARE
  r RECORD;
  base_slug VARCHAR;
  final_slug VARCHAR;
  counter INTEGER;
BEGIN
  FOR r IN 
    SELECT id, first_name, last_name, email 
    FROM tenant_identity 
    WHERE booking_slug IS NULL
  LOOP
    -- Generate base slug from name or email
    IF r.first_name IS NOT NULL AND r.last_name IS NOT NULL THEN
      base_slug := LOWER(REGEXP_REPLACE(
        CONCAT(r.first_name, '-', r.last_name),
        '[^a-zA-Z0-9-]', '', 'g'
      ));
    ELSE
      base_slug := LOWER(REGEXP_REPLACE(
        SPLIT_PART(r.email, '@', 1),
        '[^a-zA-Z0-9-]', '', 'g'
      ));
    END IF;
    
    -- Ensure slug is not empty
    IF base_slug = '' OR base_slug IS NULL THEN
      base_slug := 'user';
    END IF;
    
    -- Handle collisions by adding number suffix
    final_slug := base_slug;
    counter := 1;
    
    WHILE EXISTS (SELECT 1 FROM tenant_identity WHERE booking_slug = final_slug AND id != r.id) LOOP
      counter := counter + 1;
      final_slug := base_slug || '-' || counter;
    END LOOP;
    
    -- Update the record
    UPDATE tenant_identity SET booking_slug = final_slug WHERE id = r.id;
  END LOOP;
END;
$$;

-- Verify migration
SELECT 
  'tenant_identity with slugs' as table_name, 
  COUNT(*) as record_count 
FROM tenant_identity WHERE booking_slug IS NOT NULL
UNION ALL
SELECT 
  'agent_availability_profile' as table_name, 
  COUNT(*) as record_count 
FROM agent_availability_profile
UNION ALL
SELECT 
  'agent_booking' as table_name, 
  COUNT(*) as record_count 
FROM agent_booking;
