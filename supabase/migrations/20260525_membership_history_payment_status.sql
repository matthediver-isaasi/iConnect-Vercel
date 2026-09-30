-- Task #1017 — Membership invoice payment reconciliation
--
-- Adds payment-state tracking columns to the per-year membership history
-- tables. These mirror the lifecycle of the underlying Xero/QBO invoice
-- (separate from the existing `status` column which tracks the row's
-- membership-year lifecycle — `active` / `cancelled`).
--
-- Columns added to both `organisation_membership_history` and
-- `member_membership_history`:
--   * payment_status TEXT      — 'unpaid' | 'paid' | 'partial' | 'voided'
--                                (default 'unpaid', enforced via CHECK)
--   * paid_at        TIMESTAMPTZ — first moment the row was reconciled as
--                                  paid in the accounting provider
--
-- Indexes: a composite (tenant_id, payment_status) lets the 3-hourly cron
-- cheaply pull every outstanding invoice per tenant. We also add a partial
-- index for rows with an accounting invoice id and unpaid status — the
-- hot path for the reconciliation loop.
--
-- All operations are idempotent; safe to re-run.

DO $$
BEGIN
  -- ----- organisation_membership_history -----
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'organisation_membership_history') THEN
    ALTER TABLE organisation_membership_history
      ADD COLUMN IF NOT EXISTS payment_status TEXT NOT NULL DEFAULT 'unpaid',
      ADD COLUMN IF NOT EXISTS paid_at TIMESTAMPTZ;

    -- Add CHECK constraint if it doesn't already exist
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conname = 'organisation_membership_history_payment_status_chk'
    ) THEN
      ALTER TABLE organisation_membership_history
        ADD CONSTRAINT organisation_membership_history_payment_status_chk
        CHECK (payment_status IN ('unpaid', 'paid', 'partial', 'voided'));
    END IF;
  END IF;

  -- ----- member_membership_history -----
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'member_membership_history') THEN
    ALTER TABLE member_membership_history
      ADD COLUMN IF NOT EXISTS payment_status TEXT NOT NULL DEFAULT 'unpaid',
      ADD COLUMN IF NOT EXISTS paid_at TIMESTAMPTZ;

    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conname = 'member_membership_history_payment_status_chk'
    ) THEN
      ALTER TABLE member_membership_history
        ADD CONSTRAINT member_membership_history_payment_status_chk
        CHECK (payment_status IN ('unpaid', 'paid', 'partial', 'voided'));
    END IF;
  END IF;
END $$;

-- Indexes for the cron's "find outstanding invoices" query path.
CREATE INDEX IF NOT EXISTS organisation_membership_history_payment_status_idx
  ON organisation_membership_history (tenant_id, payment_status);

CREATE INDEX IF NOT EXISTS organisation_membership_history_unpaid_invoiced_idx
  ON organisation_membership_history (tenant_id, created_at)
  WHERE payment_status = 'unpaid'
    AND (accounting_invoice_id IS NOT NULL OR xero_invoice_id IS NOT NULL);

CREATE INDEX IF NOT EXISTS member_membership_history_payment_status_idx
  ON member_membership_history (tenant_id, payment_status);

CREATE INDEX IF NOT EXISTS member_membership_history_unpaid_invoiced_idx
  ON member_membership_history (tenant_id, created_at)
  WHERE payment_status = 'unpaid'
    AND (accounting_invoice_id IS NOT NULL OR xero_invoice_id IS NOT NULL);
