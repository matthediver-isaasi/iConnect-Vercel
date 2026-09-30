-- Task #3633 — optional invoice-per-instalment for monthly memberships.
--
-- 1. Tier-level invoicing mode for monthly plans (GC DD + Stripe card):
--    'annual' (default, current behaviour: one annual invoice, monthly
--    collections applied as part-payments) or 'per_instalment' (each
--    collection mints its own small paid invoice; no annual invoice).
ALTER TABLE membership_tier_config
  ADD COLUMN IF NOT EXISTS dd_invoicing_mode TEXT NOT NULL DEFAULT 'annual';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'membership_tier_config_dd_invoicing_mode_check'
  ) THEN
    ALTER TABLE membership_tier_config
      ADD CONSTRAINT membership_tier_config_dd_invoicing_mode_check
      CHECK (dd_invoicing_mode IN ('annual', 'per_instalment'));
  END IF;
END $$;

-- 2. Durable idempotency + sync-status store for Stripe monthly-card
--    per-instalment invoices (GC DD instalments reuse the accounting_*
--    columns already on gocardless_payments). UNIQUE (provider,
--    external_payment_id) makes webhook redelivery / reconcile replays safe.
CREATE TABLE IF NOT EXISTS membership_instalment_invoices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  plan_id UUID,
  billing_agreement_id UUID,
  provider TEXT NOT NULL,
  external_payment_id TEXT NOT NULL,
  amount_minor INTEGER,
  currency TEXT,
  accounting_provider TEXT,
  accounting_invoice_id TEXT,
  accounting_invoice_number TEXT,
  xero_invoice_id TEXT,
  xero_invoice_number TEXT,
  accounting_sync_status TEXT DEFAULT 'pending',
  accounting_sync_error TEXT,
  accounting_synced_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT membership_instalment_invoices_provider_payment_key
    UNIQUE (provider, external_payment_id)
);

CREATE INDEX IF NOT EXISTS idx_mii_plan ON membership_instalment_invoices (plan_id);
CREATE INDEX IF NOT EXISTS idx_mii_agreement ON membership_instalment_invoices (billing_agreement_id);
CREATE INDEX IF NOT EXISTS idx_mii_sync_status ON membership_instalment_invoices (accounting_sync_status);
