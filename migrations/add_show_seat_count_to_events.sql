-- Add show_seat_count column to event table
-- This allows per-event control of seat visibility when the global setting is ON
-- NULL = follow global setting (default)
-- TRUE = always show seats for this event (when global is ON)
-- FALSE = never show seats for this event

ALTER TABLE event ADD COLUMN IF NOT EXISTS show_seat_count BOOLEAN DEFAULT NULL;

COMMENT ON COLUMN event.show_seat_count IS 'Per-event seat visibility: NULL=follow global, TRUE=show, FALSE=hide (only applies when global show_event_seats is ON)';
