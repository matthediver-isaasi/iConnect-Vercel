-- Invoice Now: send next-year org membership invoice in advance.
--
-- Adds `scheduled_activation_date` to `organisation_membership_history` so that
-- an advance-invoiced ("Invoice Now") renewal record can be persisted with
-- status = 'scheduled' and later flipped to 'active' by the renewal cron on its
-- normal membership start date — without generating a duplicate invoice.
--
-- Idempotent: safe to run multiple times.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_name = 'organisation_membership_history'
  ) THEN
    ALTER TABLE organisation_membership_history
      ADD COLUMN IF NOT EXISTS scheduled_activation_date DATE;
  END IF;
END $$;

-- Partial index to make the cron activation scan cheap.
CREATE INDEX IF NOT EXISTS organisation_membership_history_scheduled_activation_idx
  ON organisation_membership_history (tenant_id, scheduled_activation_date)
  WHERE status = 'scheduled';
