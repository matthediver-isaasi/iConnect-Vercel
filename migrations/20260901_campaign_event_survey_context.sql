-- Apply through the normal migration process; no assignment tokens are stored
-- on campaigns or templates. All referenced rows are tenant-validated at send.
ALTER TABLE email_campaign
  ADD COLUMN IF NOT EXISTS event_survey_context jsonb;
ALTER TABLE event_email
  ADD COLUMN IF NOT EXISTS event_survey_assignment_id uuid;