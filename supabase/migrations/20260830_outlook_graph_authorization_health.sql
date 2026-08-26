-- Persist Microsoft Graph authorization health separately from mail sync state.
-- Existing mail/calendar connections remain active and are prompted to upgrade.
ALTER TABLE outlook_connection
  ADD COLUMN IF NOT EXISTS health_state VARCHAR NOT NULL DEFAULT 'reconnect_required',
  ADD COLUMN IF NOT EXISTS health_error TEXT,
  ADD COLUMN IF NOT EXISTS health_checked_at TIMESTAMP WITH TIME ZONE;

UPDATE outlook_connection
SET health_state = CASE
  WHEN lower(coalesce(scopes, '')) LIKE '%onlinemeetings.readwrite%'
   AND lower(coalesce(scopes, '')) LIKE '%onlinemeetingartifact.read.all%'
    THEN 'healthy'
  ELSE 'admin_consent_required'
END,
health_checked_at = NOW()
WHERE health_checked_at IS NULL;

ALTER TABLE outlook_connection
  ADD CONSTRAINT outlook_connection_health_state_check
  CHECK (health_state IN ('healthy', 'reconnect_required', 'admin_consent_required', 'error'))
  NOT VALID;