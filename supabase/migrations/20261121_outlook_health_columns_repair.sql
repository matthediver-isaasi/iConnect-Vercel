-- Idempotent repair for installations that did not receive the Outlook
-- authorization-health columns from 20260830_outlook_graph_authorization_health.sql.
-- Existing connections, credentials and already-present health metadata are untouched.
DO $repair$
DECLARE
  had_health_state boolean;
  had_health_error boolean;
  had_health_checked_at boolean;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'outlook_connection'
      AND column_name = 'health_state'
  ) INTO had_health_state;
  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'outlook_connection'
      AND column_name = 'health_error'
  ) INTO had_health_error;
  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'outlook_connection'
      AND column_name = 'health_checked_at'
  ) INTO had_health_checked_at;

  ALTER TABLE public.outlook_connection
    ADD COLUMN IF NOT EXISTS health_state varchar NOT NULL DEFAULT 'reconnect_required',
    ADD COLUMN IF NOT EXISTS health_error text,
    ADD COLUMN IF NOT EXISTS health_checked_at timestamptz;

  -- Reproduce the original migration's scope-based backfill only when the
  -- health-state model was wholly absent. This avoids rewriting metadata on a
  -- partially or fully migrated installation.
  IF NOT had_health_state AND NOT had_health_error AND NOT had_health_checked_at THEN
    UPDATE public.outlook_connection
    SET health_state = CASE
      WHEN lower(coalesce(scopes, '')) LIKE '%onlinemeetings.readwrite%'
       AND lower(coalesce(scopes, '')) LIKE '%onlinemeetingartifact.read.all%'
        THEN 'healthy'
      ELSE 'admin_consent_required'
    END,
    health_checked_at = now();
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'public.outlook_connection'::regclass
      AND conname = 'outlook_connection_health_state_check'
  ) THEN
    ALTER TABLE public.outlook_connection
      ADD CONSTRAINT outlook_connection_health_state_check
      CHECK (health_state IN (
        'healthy', 'reconnect_required', 'admin_consent_required', 'error'
      )) NOT VALID;
  END IF;
END
$repair$;