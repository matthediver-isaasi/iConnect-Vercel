-- task #687: history_log JSONB on event, complex_event, complex_event_session
-- for change-zoom + duplication audit trail
ALTER TABLE event ADD COLUMN IF NOT EXISTS history_log JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE complex_event ADD COLUMN IF NOT EXISTS history_log JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE complex_event_session ADD COLUMN IF NOT EXISTS history_log JSONB NOT NULL DEFAULT '[]'::jsonb;
