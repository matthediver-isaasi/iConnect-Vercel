-- Private, optional tenant-managed event classification.
-- Existing rows remain NULL and no public projection includes these columns.
ALTER TABLE event ADD COLUMN IF NOT EXISTS internal_event_type text;
ALTER TABLE complex_event ADD COLUMN IF NOT EXISTS internal_event_type text;

COMMENT ON COLUMN event.internal_event_type IS 'Private tenant-managed event classification; never exposed publicly.';
COMMENT ON COLUMN complex_event.internal_event_type IS 'Private tenant-managed event classification; never exposed publicly.';-- Private, optional tenant-managed event classification.
-- Existing rows remain NULL and no public projection includes these columns.
ALTER TABLE event ADD COLUMN IF NOT EXISTS internal_event_type text;
ALTER TABLE complex_event ADD COLUMN IF NOT EXISTS internal_event_type text;

COMMENT ON COLUMN event.internal_event_type IS 'Private tenant-managed event classification; never exposed publicly.';
COMMENT ON COLUMN complex_event.internal_event_type IS 'Private tenant-managed event classification; never exposed publicly.';-- Private, optional tenant-managed event classification.
-- Existing rows remain NULL and no public projection includes these columns.
ALTER TABLE event ADD COLUMN IF NOT EXISTS internal_event_type text;
ALTER TABLE complex_event ADD COLUMN IF NOT EXISTS internal_event_type text;

COMMENT ON COLUMN event.internal_event_type IS 'Private tenant-managed event classification; never exposed publicly.';
COMMENT ON COLUMN complex_event.internal_event_type IS 'Private tenant-managed event classification; never exposed publicly.';-- Private, optional tenant-managed event classification.
-- Existing rows remain NULL and no public projection includes these columns.
ALTER TABLE event ADD COLUMN IF NOT EXISTS internal_event_type text;
ALTER TABLE complex_event ADD COLUMN IF NOT EXISTS internal_event_type text;

COMMENT ON COLUMN event.internal_event_type IS 'Private tenant-managed event classification; never exposed publicly.';
COMMENT ON COLUMN complex_event.internal_event_type IS 'Private tenant-managed event classification; never exposed publicly.';-- Private, optional tenant-managed event classification.
-- Existing rows remain NULL and no public projection includes these columns.
ALTER TABLE event ADD COLUMN IF NOT EXISTS internal_event_type text;
ALTER TABLE complex_event ADD COLUMN IF NOT EXISTS internal_event_type text;

COMMENT ON COLUMN event.internal_event_type IS 'Private tenant-managed event classification; never exposed publicly.';
COMMENT ON COLUMN complex_event.internal_event_type IS 'Private tenant-managed event classification; never exposed publicly.';-- Private, optional tenant-managed event classification.
-- Existing rows remain NULL and no public projection includes these columns.
ALTER TABLE event ADD COLUMN IF NOT EXISTS internal_event_type text;
ALTER TABLE complex_event ADD COLUMN IF NOT EXISTS internal_event_type text;

COMMENT ON COLUMN event.internal_event_type IS 'Private tenant-managed event classification; never exposed publicly.';
COMMENT ON COLUMN complex_event.internal_event_type IS 'Private tenant-managed event classification; never exposed publicly.';-- Private, optional tenant-managed event classification.
-- Existing rows remain NULL and no public projection includes these columns.
ALTER TABLE event ADD COLUMN IF NOT EXISTS internal_event_type text;
ALTER TABLE complex_event ADD COLUMN IF NOT EXISTS internal_event_type text;

COMMENT ON COLUMN event.internal_event_type IS 'Private tenant-managed event classification; never exposed publicly.';
COMMENT ON COLUMN complex_event.internal_event_type IS 'Private tenant-managed event classification; never exposed publicly.';-- Private, optional tenant-managed event classification.
-- Existing rows remain NULL and no public projection includes these columns.
ALTER TABLE event ADD COLUMN IF NOT EXISTS internal_event_type text;
ALTER TABLE complex_event ADD COLUMN IF NOT EXISTS internal_event_type text;

COMMENT ON COLUMN event.internal_event_type IS 'Private tenant-managed event classification; never exposed publicly.';
COMMENT ON COLUMN complex_event.internal_event_type IS 'Private tenant-managed event classification; never exposed publicly.';