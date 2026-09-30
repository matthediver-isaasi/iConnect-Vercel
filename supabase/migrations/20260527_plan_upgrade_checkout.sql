-- Paid-plan upgrade flow (Task #1029)
--
-- Adds Stripe price-id wiring to the plan catalog so the upgrade flow can
-- create a Checkout Session per plan, plus a `tenant_subscription` table
-- tracking the live Stripe subscription that backs a tenant's plan.
--
-- All statements idempotent — safe to re-run.

-- ---------------------------------------------------------------------------
-- 1. Stripe wiring on the plan catalog
-- ---------------------------------------------------------------------------
ALTER TABLE plan ADD COLUMN IF NOT EXISTS stripe_price_id TEXT;
ALTER TABLE plan ADD COLUMN IF NOT EXISTS display_price TEXT;
ALTER TABLE plan ADD COLUMN IF NOT EXISTS description TEXT;

-- Mark paid plans as self-serve so the upgrade selector can offer them.
UPDATE plan SET is_self_serve = TRUE WHERE code IN ('starter', 'growth');

UPDATE plan SET display_price = COALESCE(display_price, '$0/mo'),       description = COALESCE(description, 'Get started for free.')                  WHERE code = 'free';
UPDATE plan SET display_price = COALESCE(display_price, '$49/mo'),      description = COALESCE(description, 'For growing groups that need more headroom.') WHERE code = 'starter';
UPDATE plan SET display_price = COALESCE(display_price, '$149/mo'),     description = COALESCE(description, 'For active organisations running regular events.') WHERE code = 'growth';
UPDATE plan SET display_price = COALESCE(display_price, 'Contact us'),  description = COALESCE(description, 'Custom limits, dedicated support.')      WHERE code = 'enterprise';

-- ---------------------------------------------------------------------------
-- 2. Tenant subscription tracking
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS tenant_subscription (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL UNIQUE,
  plan_code TEXT NOT NULL,
  stripe_customer_id TEXT,
  stripe_subscription_id TEXT,
  stripe_price_id TEXT,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'trialing', 'past_due', 'canceled', 'incomplete', 'incomplete_expired', 'unpaid', 'paused')),
  current_period_end TIMESTAMPTZ,
  cancel_at_period_end BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_tenant_subscription_tenant ON tenant_subscription(tenant_id);
CREATE INDEX IF NOT EXISTS idx_tenant_subscription_stripe_sub ON tenant_subscription(stripe_subscription_id);
CREATE INDEX IF NOT EXISTS idx_tenant_subscription_stripe_customer ON tenant_subscription(stripe_customer_id);
