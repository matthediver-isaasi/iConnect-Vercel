-- Create zoom_attendance table for storing Zoom meeting/webinar participant data
-- Used for attendance tracking and reporting after meetings end

CREATE TABLE IF NOT EXISTS zoom_attendance (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    tenant_id UUID NOT NULL,
    event_id UUID,
    complex_event_session_id UUID,
    zoom_meeting_id TEXT NOT NULL,
    zoom_type TEXT NOT NULL DEFAULT 'meeting',
    participant_email TEXT,
    participant_name TEXT,
    join_time TIMESTAMP WITH TIME ZONE,
    leave_time TIMESTAMP WITH TIME ZONE,
    duration_minutes INTEGER DEFAULT 0,
    matched_booking_id UUID,
    matched_member_id UUID,
    synced_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Unique constraint to prevent duplicates on re-sync
CREATE UNIQUE INDEX IF NOT EXISTS idx_zoom_attendance_unique
    ON zoom_attendance(zoom_meeting_id, participant_email, join_time);

-- Indexes for common queries
CREATE INDEX IF NOT EXISTS idx_zoom_attendance_tenant ON zoom_attendance(tenant_id);
CREATE INDEX IF NOT EXISTS idx_zoom_attendance_event ON zoom_attendance(event_id);
CREATE INDEX IF NOT EXISTS idx_zoom_attendance_session ON zoom_attendance(complex_event_session_id);
CREATE INDEX IF NOT EXISTS idx_zoom_attendance_zoom_meeting ON zoom_attendance(zoom_meeting_id);
CREATE INDEX IF NOT EXISTS idx_zoom_attendance_email ON zoom_attendance(participant_email);
CREATE INDEX IF NOT EXISTS idx_zoom_attendance_booking ON zoom_attendance(matched_booking_id);
CREATE INDEX IF NOT EXISTS idx_zoom_attendance_synced ON zoom_attendance(synced_at);

COMMENT ON TABLE zoom_attendance IS 'Stores Zoom meeting/webinar participant attendance data fetched from Zoom Reports API';
COMMENT ON COLUMN zoom_attendance.zoom_type IS 'Type of Zoom session: meeting or webinar';
COMMENT ON COLUMN zoom_attendance.zoom_meeting_id IS 'Zoom API meeting or webinar ID';
COMMENT ON COLUMN zoom_attendance.matched_booking_id IS 'Matched booking ID from booking or complex_event_booking table';
COMMENT ON COLUMN zoom_attendance.matched_member_id IS 'Matched member ID if participant email matches a member';
COMMENT ON COLUMN zoom_attendance.synced_at IS 'When this record was last synced from Zoom';
