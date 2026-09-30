-- Task #1112 — Surface accounting invoice creation failures.
--
-- Adds `accounting_sync_status` + `accounting_sync_error` columns to both
-- membership history tables. When a Stripe payment is captured and a
-- history row is inserted but the subsequent QBO/Xero invoice mint fails,
-- the row is flagged here so the admin UI can show a warning + retry
-- button (no longer silently swallowed as "non-fatal").
--
-- Status values:
--   NULL        - never attempted, OR previous attempt succeeded
--   'failed'    - last attempt to create/apply an accounting invoice failed
--   'retrying'  - reserved for future use (currently unused)
--
-- All operations idempotent; safe to re-run.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'organisation_membership_history') THEN
    ALTER TABLE organisation_membership_history
      ADD COLUMN IF NOT EXISTS accounting_sync_status TEXT,
      ADD COLUMN IF NOT EXISTS accounting_sync_error TEXT;

    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conname = 'organisation_membership_history_accounting_sync_status_chk'
    ) THEN
      ALTER TABLE organisation_membership_history
        ADD CONSTRAINT organisation_membership_history_accounting_sync_status_chk
        CHECK (accounting_sync_status IS NULL OR accounting_sync_status IN ('failed', 'retrying'));
    END IF;
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'member_membership_history') THEN
    ALTER TABLE member_membership_history
      ADD COLUMN IF NOT EXISTS accounting_sync_status TEXT,
      ADD COLUMN IF NOT EXISTS accounting_sync_error TEXT;

    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conname = 'member_membership_history_accounting_sync_status_chk'
    ) THEN
      ALTER TABLE member_membership_history
        ADD CONSTRAINT member_membership_history_accounting_sync_status_chk
        CHECK (accounting_sync_status IS NULL OR accounting_sync_status IN ('failed', 'retrying'));
    END IF;
  END IF;
END $$;

-- Partial index so the admin "rows that need invoice retry" lookup is cheap.
CREATE INDEX IF NOT EXISTS organisation_membership_history_accounting_failed_idx
  ON organisation_membership_history (tenant_id, organization_id)
  WHERE accounting_sync_status = 'failed';

CREATE INDEX IF NOT EXISTS member_membership_history_accounting_failed_idx
  ON member_membership_history (tenant_id, member_id)
  WHERE accounting_sync_status = 'failed';
