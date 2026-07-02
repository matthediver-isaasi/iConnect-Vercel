-- Create complex_event_session table for managing individual sessions within complex/multi-session events
-- Each session can independently link to its own Zoom meeting or webinar

CREATE TABLE IF NOT EXISTS complex_event_session (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    event_id UUID NOT NULL,
    tenant_id UUID NOT NULL,
    title TEXT NOT NULL,
    description TEXT,
    start_time TIMESTAMP WITH TIME ZONE,
    end_time TIMESTAMP WITH TIME ZONE,
    duration_minutes INTEGER DEFAULT 60,
    timezone TEXT DEFAULT 'Europe/London',
    delivery_mode TEXT DEFAULT 'in_person',
    track_name TEXT,
    sort_order INTEGER DEFAULT 0,
    zoom_type TEXT,
    zoom_meeting_id TEXT,
    zoom_webinar_id TEXT,
    zoom_join_url TEXT,
    zoom_start_url TEXT,
    zoom_host_id TEXT,
    zoom_host_email TEXT,
    zoom_password TEXT,
    zoom_registration_required BOOLEAN DEFAULT false,
    zoom_registration_url TEXT,
    status TEXT DEFAULT 'scheduled',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ces_event_id ON complex_event_session(event_id);
CREATE INDEX IF NOT EXISTS idx_ces_tenant_id ON complex_event_session(tenant_id);
CREATE INDEX IF NOT EXISTS idx_ces_start_time ON complex_event_session(start_time);
CREATE INDEX IF NOT EXISTS idx_ces_status ON complex_event_session(status);
CREATE INDEX IF NOT EXISTS idx_ces_track_name ON complex_event_session(track_name);

-- Additive ALTER TABLE statements: ensure all Zoom columns exist on the table
-- even if it was previously created without them. Uses IF NOT EXISTS pattern.
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'complex_event_session' AND column_name = 'zoom_type') THEN
        ALTER TABLE complex_event_session ADD COLUMN zoom_type TEXT;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'complex_event_session' AND column_name = 'zoom_meeting_id') THEN
        ALTER TABLE complex_event_session ADD COLUMN zoom_meeting_id TEXT;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'complex_event_session' AND column_name = 'zoom_webinar_id') THEN
        ALTER TABLE complex_event_session ADD COLUMN zoom_webinar_id TEXT;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'complex_event_session' AND column_name = 'zoom_join_url') THEN
        ALTER TABLE complex_event_session ADD COLUMN zoom_join_url TEXT;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'complex_event_session' AND column_name = 'zoom_start_url') THEN
        ALTER TABLE complex_event_session ADD COLUMN zoom_start_url TEXT;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'complex_event_session' AND column_name = 'zoom_host_id') THEN
        ALTER TABLE complex_event_session ADD COLUMN zoom_host_id TEXT;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'complex_event_session' AND column_name = 'zoom_host_email') THEN
        ALTER TABLE complex_event_session ADD COLUMN zoom_host_email TEXT;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'complex_event_session' AND column_name = 'zoom_password') THEN
        ALTER TABLE complex_event_session ADD COLUMN zoom_password TEXT;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'complex_event_session' AND column_name = 'zoom_registration_required') THEN
        ALTER TABLE complex_event_session ADD COLUMN zoom_registration_required BOOLEAN DEFAULT false;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'complex_event_session' AND column_name = 'zoom_registration_url') THEN
        ALTER TABLE complex_event_session ADD COLUMN zoom_registration_url TEXT;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'complex_event_session' AND column_name = 'delivery_mode') THEN
        ALTER TABLE complex_event_session ADD COLUMN delivery_mode TEXT DEFAULT 'in_person';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'complex_event_session' AND column_name = 'track_name') THEN
        ALTER TABLE complex_event_session ADD COLUMN track_name TEXT;
    END IF;
END $$;

-- Add is_complex flag to event table if it doesn't exist
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'event' AND column_name = 'is_complex') THEN
        ALTER TABLE event ADD COLUMN is_complex BOOLEAN DEFAULT false;
    END IF;
END $$;

COMMENT ON TABLE complex_event_session IS 'Individual sessions within complex/multi-session events, each with optional Zoom integration';
COMMENT ON COLUMN complex_event_session.event_id IS 'Parent event ID';
COMMENT ON COLUMN complex_event_session.delivery_mode IS 'Session delivery: in_person, virtual, hybrid';
COMMENT ON COLUMN complex_event_session.track_name IS 'Track/stream name for multi-track events';
COMMENT ON COLUMN complex_event_session.zoom_type IS 'Type of Zoom integration: meeting or webinar';
COMMENT ON COLUMN complex_event_session.zoom_meeting_id IS 'Zoom API meeting ID (for meetings)';
COMMENT ON COLUMN complex_event_session.zoom_webinar_id IS 'Zoom API webinar ID (for webinars)';
COMMENT ON COLUMN complex_event_session.zoom_join_url IS 'Zoom join URL for attendees';
COMMENT ON COLUMN complex_event_session.zoom_start_url IS 'Zoom start URL for hosts';
COMMENT ON COLUMN complex_event_session.zoom_host_id IS 'Zoom host user ID';
COMMENT ON COLUMN complex_event_session.zoom_registration_required IS 'Whether Zoom webinar registration is required';
