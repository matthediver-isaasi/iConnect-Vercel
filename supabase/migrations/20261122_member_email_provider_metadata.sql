-- Allow CRM-originated Mailgun messages to share member email history without
-- inventing Microsoft Graph identifiers.
ALTER TABLE member_email
  ALTER COLUMN microsoft_message_id DROP NOT NULL,
  ADD COLUMN IF NOT EXISTS email_provider text,
  ADD COLUMN IF NOT EXISTS provider_message_id text;

CREATE UNIQUE INDEX IF NOT EXISTS member_email_provider_message_unique
  ON member_email (tenant_id, email_provider, provider_message_id)
  WHERE email_provider IS NOT NULL AND provider_message_id IS NOT NULL;