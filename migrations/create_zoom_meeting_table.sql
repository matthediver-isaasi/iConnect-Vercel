-- Create zoom_meeting table for storing Zoom meeting data
-- This is parallel to zoom_webinar table but for meetings

CREATE TABLE IF NOT EXISTS zoom_meeting (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    topic TEXT NOT NULL,
    agenda TEXT,
    start_time TIMESTAMP WITH TIME ZONE NOT NULL,
    duration_minutes INTEGER DEFAULT 60,
    timezone TEXT DEFAULT 'Europe/London',
    waiting_room BOOLEAN DEFAULT true,
    join_before_host BOOLEAN DEFAULT false,
    mute_upon_entry BOOLEAN DEFAULT true,
    zoom_meeting_id TEXT,
    zoom_host_id TEXT,
    join_url TEXT,
    start_url TEXT,
    password TEXT,
    status TEXT DEFAULT 'scheduled',
    created_by_member_id UUID,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Add indexes for common queries
CREATE INDEX IF NOT EXISTS idx_zoom_meeting_start_time ON zoom_meeting(start_time);
CREATE INDEX IF NOT EXISTS idx_zoom_meeting_status ON zoom_meeting(status);
CREATE INDEX IF NOT EXISTS idx_zoom_meeting_zoom_id ON zoom_meeting(zoom_meeting_id);

-- Add zoom_meeting_id column to event table if it doesn't exist
DO $$ 
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'event' AND column_name = 'zoom_meeting_id') THEN
        ALTER TABLE event ADD COLUMN zoom_meeting_id TEXT;
    END IF;
END $$;

COMMENT ON TABLE zoom_meeting IS 'Stores Zoom meeting configurations and details';
COMMENT ON COLUMN zoom_meeting.topic IS 'Meeting title/topic';
COMMENT ON COLUMN zoom_meeting.agenda IS 'Meeting description/agenda (supports HTML)';
COMMENT ON COLUMN zoom_meeting.waiting_room IS 'Whether waiting room is enabled';
COMMENT ON COLUMN zoom_meeting.join_before_host IS 'Whether participants can join before host';
COMMENT ON COLUMN zoom_meeting.mute_upon_entry IS 'Whether participants are muted on entry';
COMMENT ON COLUMN zoom_meeting.zoom_meeting_id IS 'Zoom API meeting ID';
COMMENT ON COLUMN zoom_meeting.status IS 'Meeting status: scheduled, started, ended, cancelled';
