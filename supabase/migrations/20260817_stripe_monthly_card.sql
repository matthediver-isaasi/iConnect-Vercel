-- Task #3620 — Monthly membership payments by card via Stripe Subscriptions.
-- Idempotent: safe to re-run.
--
-- Provider-aware plan model: billing agreements and payment plans record
-- their provider ('gocardless' | 'stripe'). Existing GC columns stay
-- strictly GC; new stripe_* columns are strictly Stripe.

ALTER TABLE membership_billing_agreements
  ADD COLUMN IF NOT EXISTS provider TEXT NOT NULL DEFAULT 'gocardless',
  ADD COLUMN IF NOT EXISTS stripe_customer_id TEXT,
  ADD COLUMN IF NOT EXISTS stripe_checkout_session_id TEXT,
  ADD COLUMN IF NOT EXISTS stripe_subscription_id TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS membership_billing_agreements_stripe_cs_uniq
  ON membership_billing_agreements (stripe_checkout_session_id)
  WHERE stripe_checkout_session_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS membership_billing_agreements_stripe_sub_idx
  ON membership_billing_agreements (stripe_subscription_id)
  WHERE stripe_subscription_id IS NOT NULL;

ALTER TABLE membership_payment_plans
  ADD COLUMN IF NOT EXISTS provider TEXT NOT NULL DEFAULT 'gocardless',
  ADD COLUMN IF NOT EXISTS stripe_customer_id TEXT,
  ADD COLUMN IF NOT EXISTS stripe_subscription_id TEXT,
  ADD COLUMN IF NOT EXISTS instalments_paid INTEGER NOT NULL DEFAULT 0;

CREATE UNIQUE INDEX IF NOT EXISTS membership_payment_plans_stripe_sub_uniq
  ON membership_payment_plans (stripe_subscription_id)
  WHERE stripe_subscription_id IS NOT NULL;

-- Tier config: monthly card is enabled independently of Direct Debit; the
-- monthly amount / instalment count / activation & grace terms are shared
-- with the DD configuration (dd_monthly_amount etc.).
ALTER TABLE membership_tier_config
  ADD COLUMN IF NOT EXISTS card_monthly_enabled BOOLEAN NOT NULL DEFAULT false;
