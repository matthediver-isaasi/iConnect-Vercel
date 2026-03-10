-- Add guest info columns to booking table
-- These store the free-text fields collected from unauthenticated (guest) event bookings

ALTER TABLE booking ADD COLUMN IF NOT EXISTS guest_organisation_name text;
ALTER TABLE booking ADD COLUMN IF NOT EXISTS attendee_phone text;
ALTER TABLE booking ADD COLUMN IF NOT EXISTS attendee_job_title text;
