-- GoCardless Phase 4 — failure handling, refunds, finance & admin console.
-- Idempotent: safe to re-run.
--
--   gocardless_payments               — gross/fee/net, payout, refund, chargeback,
--                                       accounting posting columns
--   membership_payment_plans          — grace-period tracking (expiry, policy applied)
--   membership_tier_config            — dd_arrears_policy (post-grace policy)
--   gocardless_refunds                — refund mirror (webhook + admin-initiated)
--   gocardless_payouts                — payout mirror for reconciliation
--   membership_dd_cancellation_requests — member cancellation requests (admin review)
--   membership_dd_admin_actions       — audit log of every admin DD action + notes

ALTER TABLE gocardless_payments
  ADD COLUMN IF NOT EXISTS description TEXT,
  ADD COLUMN IF NOT EXISTS fee_minor INTEGER,
  ADD COLUMN IF NOT EXISTS net_minor INTEGER,
  ADD COLUMN IF NOT EXISTS amount_refunded_minor INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS refund_status TEXT,           -- null | pending | partially_refunded | refunded
  ADD COLUMN IF NOT EXISTS charged_back_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS chargeback_reversed_after_payout BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS confirmed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS paid_out_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS gocardless_payout_id TEXT,
  ADD COLUMN IF NOT EXISTS payout_reference TEXT,
  ADD COLUMN IF NOT EXISTS payout_date DATE,
  ADD COLUMN IF NOT EXISTS accounting_provider TEXT,
  ADD COLUMN IF NOT EXISTS accounting_invoice_id TEXT,
  ADD COLUMN IF NOT EXISTS accounting_invoice_number TEXT,
  ADD COLUMN IF NOT EXISTS xero_invoice_id TEXT,
  ADD COLUMN IF NOT EXISTS xero_invoice_number TEXT,
  ADD COLUMN IF NOT EXISTS accounting_sync_status TEXT,  -- null | pending | posted | failed | skipped
  ADD COLUMN IF NOT EXISTS accounting_synced_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS accounting_sync_error TEXT;

CREATE INDEX IF NOT EXISTS gocardless_payments_payout_idx
  ON gocardless_payments (gocardless_payout_id)
  WHERE gocardless_payout_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS gocardless_payments_status_idx
  ON gocardless_payments (tenant_id, status);

ALTER TABLE membership_payment_plans
  ADD COLUMN IF NOT EXISTS grace_expires_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS grace_extended_days INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS arrears_policy_applied TEXT,   -- policy applied when grace expired
  ADD COLUMN IF NOT EXISTS arrears_policy_applied_at TIMESTAMPTZ;

ALTER TABLE membership_tier_config
  ADD COLUMN IF NOT EXISTS dd_arrears_policy TEXT NOT NULL DEFAULT 'manual_review';
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'membership_tier_config_dd_arrears_policy_check'
  ) THEN
    ALTER TABLE membership_tier_config
      ADD CONSTRAINT membership_tier_config_dd_arrears_policy_check
      CHECK (dd_arrears_policy IN ('keep_active', 'restrict', 'suspend', 'manual_review', 'cancel_at_period_end'));
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS gocardless_refunds (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  gocardless_refund_id TEXT NOT NULL,
  gocardless_payment_id TEXT NOT NULL,
  payment_row_id UUID REFERENCES gocardless_payments(id),
  amount_minor INTEGER,
  currency TEXT,
  status TEXT NOT NULL DEFAULT 'created', -- created | submitted | paid | refund_settled | failed | funds_returned
  reason TEXT,
  initiated_by TEXT,                      -- admin email when admin-initiated; null when webhook-mirrored
  idempotency_key TEXT,
  environment TEXT NOT NULL DEFAULT 'sandbox',
  metadata JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS gocardless_refunds_gc_id_uniq
  ON gocardless_refunds (gocardless_refund_id);
CREATE UNIQUE INDEX IF NOT EXISTS gocardless_refunds_idem_uniq
  ON gocardless_refunds (idempotency_key)
  WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS gocardless_refunds_payment_idx
  ON gocardless_refunds (gocardless_payment_id);
CREATE INDEX IF NOT EXISTS gocardless_refunds_tenant_idx
  ON gocardless_refunds (tenant_id);

CREATE TABLE IF NOT EXISTS gocardless_payouts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID,
  gocardless_payout_id TEXT NOT NULL,
  reference TEXT,
  amount_minor INTEGER,
  deducted_fees_minor INTEGER,
  currency TEXT,
  status TEXT,
  arrival_date DATE,
  environment TEXT NOT NULL DEFAULT 'sandbox',
  reconciled BOOLEAN NOT NULL DEFAULT false,
  reconciliation_difference_minor INTEGER,
  metadata JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS gocardless_payouts_gc_id_uniq
  ON gocardless_payouts (gocardless_payout_id);
CREATE INDEX IF NOT EXISTS gocardless_payouts_tenant_idx
  ON gocardless_payouts (tenant_id);

-- Member-initiated cancellation requests for DD plans. Deciding a request is
-- separate from the actual subscription/mandate cancel actions.
CREATE TABLE IF NOT EXISTS membership_dd_cancellation_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  plan_id UUID REFERENCES membership_payment_plans(id),
  billing_agreement_id UUID REFERENCES membership_billing_agreements(id),
  member_id UUID,
  organization_id UUID,
  requested_by_email TEXT,
  reason TEXT,
  effective_preference TEXT NOT NULL DEFAULT 'immediate', -- immediate | period_end
  status TEXT NOT NULL DEFAULT 'pending',                 -- pending | approved | rejected | withdrawn
  snapshot JSONB,                                         -- commitment/instalments summary at request time
  decided_by TEXT,
  decided_at TIMESTAMPTZ,
  decision_notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS membership_dd_cancellation_requests_tenant_idx
  ON membership_dd_cancellation_requests (tenant_id, status);
CREATE INDEX IF NOT EXISTS membership_dd_cancellation_requests_plan_idx
  ON membership_dd_cancellation_requests (plan_id)
  WHERE plan_id IS NOT NULL;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'membership_dd_cancellation_requests_status_check'
  ) THEN
    ALTER TABLE membership_dd_cancellation_requests
      ADD CONSTRAINT membership_dd_cancellation_requests_status_check
      CHECK (status IN ('pending', 'approved', 'rejected', 'withdrawn'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'membership_dd_cancellation_requests_pref_check'
  ) THEN
    ALTER TABLE membership_dd_cancellation_requests
      ADD CONSTRAINT membership_dd_cancellation_requests_pref_check
      CHECK (effective_preference IN ('immediate', 'period_end'));
  END IF;
END $$;

-- Audit log: one row per admin DD console action (including notes).
CREATE TABLE IF NOT EXISTS membership_dd_admin_actions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  plan_id UUID,
  billing_agreement_id UUID,
  gocardless_payment_id TEXT,
  action TEXT NOT NULL,   -- retry | refund | cancel_subscription | cancel_mandate | pause | resume | extend_grace | manual_resolve | remind | resend_link | reconcile | note | cancellation_decision | export
  actor_email TEXT,
  details JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS membership_dd_admin_actions_tenant_idx
  ON membership_dd_admin_actions (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS membership_dd_admin_actions_plan_idx
  ON membership_dd_admin_actions (plan_id)
  WHERE plan_id IS NOT NULL;
