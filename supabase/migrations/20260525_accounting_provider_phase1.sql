-- QuickBooks Phase 1: Accounting provider abstraction (Task #996)
--
-- Adds:
--   * tenant_accounting_settings.active_provider — per-tenant active provider
--     (xero | quickbooks | none). Single source of truth used by the
--     api/_lib/accountingProvider.js facade.
--   * quickbooks_token table — mirrors xero_token shape so Phase 2 (QBO
--     OAuth flow) can land cleanly without further schema work. Nothing
--     reads/writes it in Phase 1.
--   * Provider-agnostic accounting reference columns on booking,
--     complex_event_booking, organisation_membership_history, and
--     member_membership_history. Existing xero_* columns are kept; new
--     writes populate both legacy + generalized columns.
--
-- All changes are additive and idempotent. Nothing here touches historical
-- data — pre-existing rows keep their xero_* values and continue to
-- resolve via the Xero provider.

-- ---------------------------------------------------------------------------
-- 1. Per-tenant active accounting provider
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS tenant_accounting_settings (
  tenant_id UUID PRIMARY KEY,
  active_provider TEXT NOT NULL DEFAULT 'none'
    CHECK (active_provider IN ('xero', 'quickbooks', 'none')),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Backfill: any tenant that already has a (non-pending) Xero token is
-- treated as actively connected to Xero. We only insert; we never
-- overwrite an existing row in case an admin has already chosen a value.
INSERT INTO tenant_accounting_settings (tenant_id, active_provider, updated_at)
SELECT DISTINCT app_tenant_id, 'xero', NOW()
FROM xero_token
WHERE app_tenant_id IS NOT NULL
  AND tenant_id IS DISTINCT FROM 'PENDING_SELECTION'
ON CONFLICT (tenant_id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 2. QuickBooks Online token storage (mirrors xero_token)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS quickbooks_token (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  app_tenant_id UUID,
  realm_id VARCHAR(64),
  company_name VARCHAR(255),
  access_token TEXT,
  refresh_token TEXT,
  token_type VARCHAR(32) DEFAULT 'bearer',
  expires_at TIMESTAMPTZ,
  environment VARCHAR(16) NOT NULL DEFAULT 'production'
    CHECK (environment IN ('production', 'sandbox')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_quickbooks_token_app_tenant_id
  ON quickbooks_token(app_tenant_id);
CREATE INDEX IF NOT EXISTS idx_quickbooks_token_realm_id
  ON quickbooks_token(realm_id);

-- ---------------------------------------------------------------------------
-- 3. Provider-agnostic accounting reference columns
--    Each table gets:
--      accounting_provider          — 'xero' | 'quickbooks'
--      accounting_invoice_id        — provider-native invoice id
--      accounting_invoice_number    — human-readable invoice number
--      accounting_credit_note_id    — provider-native credit-note id (where applicable)
--      accounting_credit_note_number
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  -- booking
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'booking') THEN
    ALTER TABLE booking
      ADD COLUMN IF NOT EXISTS accounting_provider TEXT,
      ADD COLUMN IF NOT EXISTS accounting_invoice_id TEXT,
      ADD COLUMN IF NOT EXISTS accounting_invoice_number TEXT,
      ADD COLUMN IF NOT EXISTS accounting_credit_note_id TEXT,
      ADD COLUMN IF NOT EXISTS accounting_credit_note_number TEXT;
  END IF;

  -- complex_event_booking
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'complex_event_booking') THEN
    ALTER TABLE complex_event_booking
      ADD COLUMN IF NOT EXISTS accounting_provider TEXT,
      ADD COLUMN IF NOT EXISTS accounting_invoice_id TEXT,
      ADD COLUMN IF NOT EXISTS accounting_invoice_number TEXT,
      ADD COLUMN IF NOT EXISTS accounting_credit_note_id TEXT,
      ADD COLUMN IF NOT EXISTS accounting_credit_note_number TEXT;
  END IF;

  -- organisation_membership_history
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'organisation_membership_history') THEN
    ALTER TABLE organisation_membership_history
      ADD COLUMN IF NOT EXISTS accounting_provider TEXT,
      ADD COLUMN IF NOT EXISTS accounting_invoice_id TEXT,
      ADD COLUMN IF NOT EXISTS accounting_invoice_number TEXT,
      ADD COLUMN IF NOT EXISTS accounting_credit_note_id TEXT,
      ADD COLUMN IF NOT EXISTS accounting_credit_note_number TEXT;
  END IF;

  -- member_membership_history (parity with org history; not explicitly listed
  -- in task spec but writes follow the same pattern in the cron and manual
  -- renewal paths, so we generalize here too)
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'member_membership_history') THEN
    ALTER TABLE member_membership_history
      ADD COLUMN IF NOT EXISTS accounting_provider TEXT,
      ADD COLUMN IF NOT EXISTS accounting_invoice_id TEXT,
      ADD COLUMN IF NOT EXISTS accounting_invoice_number TEXT,
      ADD COLUMN IF NOT EXISTS accounting_credit_note_id TEXT,
      ADD COLUMN IF NOT EXISTS accounting_credit_note_number TEXT;
  END IF;
END $$;
