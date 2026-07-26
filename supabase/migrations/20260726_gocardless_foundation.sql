-- GoCardless Phase 1 — technical foundation tables.
-- Idempotent: safe to re-run.
--
-- Tables:
--   gocardless_customers              — GC customer <-> local member/org link
--   gocardless_mandates               — GC mandate state mirror
--   membership_billing_agreements     — the setup journey (billing request/flow)
--   membership_payment_plans          — GC subscription state mirror (monthly DD plan)
--   gocardless_payments               — individual GC payment state mirror
--   payment_webhook_events            — durable webhook event log (dedupe on event id)
--   membership_payment_status_history — audit trail of every status transition

CREATE TABLE IF NOT EXISTS gocardless_customers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  member_id UUID,
  organization_id UUID,
  gocardless_customer_id TEXT NOT NULL,
  email TEXT,
  environment TEXT NOT NULL DEFAULT 'sandbox',
  metadata JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS gocardless_customers_gc_id_uniq
  ON gocardless_customers (gocardless_customer_id);
CREATE INDEX IF NOT EXISTS gocardless_customers_tenant_idx
  ON gocardless_customers (tenant_id);

CREATE TABLE IF NOT EXISTS gocardless_mandates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  gocardless_customer_id TEXT,
  gocardless_mandate_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending_submission',
  scheme TEXT,
  reference TEXT,
  next_possible_charge_date DATE,
  environment TEXT NOT NULL DEFAULT 'sandbox',
  metadata JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS gocardless_mandates_gc_id_uniq
  ON gocardless_mandates (gocardless_mandate_id);
CREATE INDEX IF NOT EXISTS gocardless_mandates_tenant_idx
  ON gocardless_mandates (tenant_id);

CREATE TABLE IF NOT EXISTS membership_billing_agreements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  member_id UUID,
  organization_id UUID,
  agreement_type TEXT NOT NULL DEFAULT 'member', -- 'member' | 'organization'
  gocardless_customer_id TEXT,
  gocardless_mandate_id TEXT,
  gocardless_billing_request_id TEXT,
  gocardless_billing_request_flow_id TEXT,
  status TEXT NOT NULL DEFAULT 'payment_setup_required',
  idempotency_key TEXT,
  redirect_url TEXT,
  environment TEXT NOT NULL DEFAULT 'sandbox',
  needs_attention BOOLEAN NOT NULL DEFAULT false,
  attention_reason TEXT,
  metadata JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS membership_billing_agreements_br_uniq
  ON membership_billing_agreements (gocardless_billing_request_id)
  WHERE gocardless_billing_request_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS membership_billing_agreements_idem_uniq
  ON membership_billing_agreements (idempotency_key)
  WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS membership_billing_agreements_tenant_idx
  ON membership_billing_agreements (tenant_id);
CREATE INDEX IF NOT EXISTS membership_billing_agreements_mandate_idx
  ON membership_billing_agreements (gocardless_mandate_id)
  WHERE gocardless_mandate_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS membership_payment_plans (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  billing_agreement_id UUID REFERENCES membership_billing_agreements(id),
  member_id UUID,
  organization_id UUID,
  gocardless_subscription_id TEXT,
  gocardless_mandate_id TEXT,
  amount_minor INTEGER,             -- integer minor units (pence)
  currency TEXT NOT NULL DEFAULT 'GBP',
  interval_unit TEXT NOT NULL DEFAULT 'monthly',
  day_of_month INTEGER,
  status TEXT NOT NULL DEFAULT 'payment_setup_required',
  membership_year TEXT,
  start_date DATE,
  next_charge_date DATE,
  last_payment_id TEXT,
  last_payment_status TEXT,
  last_payment_at TIMESTAMPTZ,
  retry_count INTEGER NOT NULL DEFAULT 0,
  idempotency_key TEXT,
  environment TEXT NOT NULL DEFAULT 'sandbox',
  needs_attention BOOLEAN NOT NULL DEFAULT false,
  attention_reason TEXT,
  metadata JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS membership_payment_plans_sub_uniq
  ON membership_payment_plans (gocardless_subscription_id)
  WHERE gocardless_subscription_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS membership_payment_plans_idem_uniq
  ON membership_payment_plans (idempotency_key)
  WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS membership_payment_plans_tenant_idx
  ON membership_payment_plans (tenant_id);
CREATE INDEX IF NOT EXISTS membership_payment_plans_mandate_idx
  ON membership_payment_plans (gocardless_mandate_id)
  WHERE gocardless_mandate_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS gocardless_payments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  plan_id UUID REFERENCES membership_payment_plans(id),
  gocardless_payment_id TEXT NOT NULL,
  gocardless_subscription_id TEXT,
  gocardless_mandate_id TEXT,
  amount_minor INTEGER,
  currency TEXT,
  status TEXT NOT NULL DEFAULT 'pending_submission',
  charge_date DATE,
  environment TEXT NOT NULL DEFAULT 'sandbox',
  metadata JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS gocardless_payments_gc_id_uniq
  ON gocardless_payments (gocardless_payment_id);
CREATE INDEX IF NOT EXISTS gocardless_payments_tenant_idx
  ON gocardless_payments (tenant_id);
CREATE INDEX IF NOT EXISTS gocardless_payments_plan_idx
  ON gocardless_payments (plan_id) WHERE plan_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS payment_webhook_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider TEXT NOT NULL DEFAULT 'gocardless',
  event_id TEXT NOT NULL,
  resource_type TEXT,
  action TEXT,
  resource_id TEXT,
  tenant_id UUID,
  payload JSONB,
  processing_status TEXT NOT NULL DEFAULT 'pending', -- pending|processed|failed|skipped
  processing_error TEXT,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS payment_webhook_events_event_uniq
  ON payment_webhook_events (provider, event_id);
CREATE INDEX IF NOT EXISTS payment_webhook_events_status_idx
  ON payment_webhook_events (processing_status)
  WHERE processing_status IN ('pending', 'failed');

CREATE TABLE IF NOT EXISTS membership_payment_status_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  entity_type TEXT NOT NULL, -- 'billing_agreement' | 'payment_plan' | 'payment'
  entity_id UUID,
  gocardless_payment_id TEXT,
  from_status TEXT,
  to_status TEXT NOT NULL,
  reason TEXT,
  source TEXT NOT NULL DEFAULT 'system', -- 'webhook' | 'reconciliation' | 'system'
  event_id TEXT,
  metadata JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS membership_payment_status_history_entity_idx
  ON membership_payment_status_history (entity_type, entity_id);
CREATE INDEX IF NOT EXISTS membership_payment_status_history_tenant_idx
  ON membership_payment_status_history (tenant_id);
