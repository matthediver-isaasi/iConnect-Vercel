-- Add registration_required to zoom_meeting (Task #2819)
--
-- zoom_webinar has had a registration_required column for a long time, but
-- zoom_meeting never did. Several code paths (change-zoom handlers,
-- resend-confirmation) SELECT registration_required off zoom_meeting rows,
-- which fails with 42703 in production and was misreported as a
-- "not found for this tenant" 400.
--
-- Meetings created through the app do not currently enable Zoom registration
-- (the creation payload sets no approval/registration settings), so a default
-- of false is correct for all existing rows.
--
-- Idempotent: safe to run multiple times.

ALTER TABLE zoom_meeting
  ADD COLUMN IF NOT EXISTS registration_required boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN zoom_meeting.registration_required IS
  'Whether the Zoom meeting requires registrant sign-up (mirrors zoom_webinar.registration_required). Meetings created without explicit registration settings default to false.';
