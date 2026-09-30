-- Migration: Add Outlook calendar integration for booking system
-- Adds outlook_event_id to agent_booking table to track linked calendar events

ALTER TABLE agent_booking 
ADD COLUMN IF NOT EXISTS outlook_event_id TEXT;

COMMENT ON COLUMN agent_booking.outlook_event_id IS 'Microsoft Graph calendar event ID for synced bookings';
