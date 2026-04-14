-- Event Email Configuration Table
-- Run this SQL in your Supabase SQL Editor to create the event_email table

-- Create event_email table for storing email configurations per event
CREATE TABLE IF NOT EXISTS event_email (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id UUID NOT NULL,
  email_type VARCHAR(50) NOT NULL CHECK (email_type IN ('booking_confirmation', 'reminder')),
  timing_type VARCHAR(50) CHECK (timing_type IN ('7_days_before', '3_days_before', '1_day_before', '12_hours_before', '6_hours_before', '1_hour_before', '30_minutes_before', 'custom')),
  custom_hours_before INTEGER,
  custom_unit VARCHAR(50),
  custom_send_at TIMESTAMP WITH TIME ZONE,
  subject VARCHAR(500) NOT NULL,
  body TEXT NOT NULL,
  is_enabled BOOLEAN DEFAULT true,
  is_complex_event BOOLEAN DEFAULT false,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Migration for existing tables: drop FK so complex event IDs (from complex_event table) can be stored
ALTER TABLE event_email DROP CONSTRAINT IF EXISTS event_email_event_id_fkey;

-- Migration for existing tables: add is_complex_event column
ALTER TABLE event_email ADD COLUMN IF NOT EXISTS is_complex_event BOOLEAN DEFAULT false;

-- Migration for existing tables: add custom_unit and custom_send_at columns for custom timing support
ALTER TABLE event_email ADD COLUMN IF NOT EXISTS custom_unit VARCHAR(50);
ALTER TABLE event_email ADD COLUMN IF NOT EXISTS custom_send_at TIMESTAMP WITH TIME ZONE;

-- Create index for faster lookups by event_id
CREATE INDEX IF NOT EXISTS idx_event_email_event_id ON event_email(event_id);

-- Create index for reminder processing
CREATE INDEX IF NOT EXISTS idx_event_email_enabled_type ON event_email(is_enabled, email_type);

-- Create scheduled_email table for tracking sent reminders
CREATE TABLE IF NOT EXISTS scheduled_email (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_email_id UUID NOT NULL REFERENCES event_email(id) ON DELETE CASCADE,
  booking_id UUID NOT NULL,
  attendee_email VARCHAR(255) NOT NULL,
  scheduled_send_time TIMESTAMP WITH TIME ZONE NOT NULL,
  sent_at TIMESTAMP WITH TIME ZONE,
  status VARCHAR(50) DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed', 'cancelled')),
  error_message TEXT,
  session_id UUID,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Migration for existing tables: add session_id column for per-session reminder tracking
ALTER TABLE scheduled_email ADD COLUMN IF NOT EXISTS session_id UUID;

-- Index for finding pending emails to send
CREATE INDEX IF NOT EXISTS idx_scheduled_email_pending ON scheduled_email(status, scheduled_send_time) 
  WHERE status = 'pending';

-- Index for looking up emails by booking
CREATE INDEX IF NOT EXISTS idx_scheduled_email_booking ON scheduled_email(booking_id);

-- Index for looking up emails by session
CREATE INDEX IF NOT EXISTS idx_scheduled_email_session ON scheduled_email(session_id) WHERE session_id IS NOT NULL;

-- Unique constraint to prevent duplicate scheduled emails per booking/email/session
CREATE UNIQUE INDEX IF NOT EXISTS idx_scheduled_email_unique 
  ON scheduled_email(event_email_id, booking_id, COALESCE(session_id, '00000000-0000-0000-0000-000000000000'));
