-- Tenant GoCardless automatic collection retries.
-- Idempotent: safe to re-run.
--
-- Policy is stored in tenant_integrations.credentials as non-secret fields:
--   auto_retry_enabled, auto_retry_interval_days, auto_retry_max_attempts
-- The plan columns hold the current schedule and a short-lived cross-path
-- claim. The attempt ledger retains every automatic and manual request.

ALTER TABLE membership_payment_plans
  ADD COLUMN IF NOT EXISTS auto_retry_attempts INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS auto_retry_next_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS auto_retry_payment_id TEXT,
  ADD COLUMN IF NOT EXISTS auto_retry_claimed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS auto_retry_claim_token TEXT,
  ADD COLUMN IF NOT EXISTS auto_retry_last_outcome TEXT,
  ADD COLUMN IF NOT EXISTS auto_retry_last_error TEXT,
  ADD COLUMN IF NOT EXISTS auto_retry_exhausted_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS membership_payment_plans_auto_retry_due_idx
  ON membership_payment_plans (auto_retry_next_at, tenant_id)
  WHERE auto_retry_next_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS gocardless_payment_retry_attempts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  plan_id UUID NOT NULL REFERENCES membership_payment_plans(id),
  gocardless_payment_id TEXT NOT NULL,
  attempt_number INTEGER NOT NULL,
  mode TEXT NOT NULL DEFAULT 'automatic', -- automatic | manual
  status TEXT NOT NULL DEFAULT 'claimed', -- claimed | requested | failed | refused | recovered
  idempotency_key TEXT NOT NULL,
  provider_status TEXT,
  outcome TEXT,
  error_message TEXT,
  claimed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT gocardless_retry_attempt_mode_check CHECK (mode IN ('automatic', 'manual')),
  CONSTRAINT gocardless_retry_attempt_status_check CHECK (status IN ('claimed', 'requested', 'failed', 'refused', 'recovered')),
  CONSTRAINT gocardless_retry_attempt_number_check CHECK (attempt_number >= 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS gocardless_retry_attempt_idem_idx
  ON gocardless_payment_retry_attempts (idempotency_key);
CREATE UNIQUE INDEX IF NOT EXISTS gocardless_retry_attempt_payment_number_idx
  ON gocardless_payment_retry_attempts (gocardless_payment_id, mode, attempt_number);
CREATE INDEX IF NOT EXISTS gocardless_retry_attempt_tenant_idx
  ON gocardless_payment_retry_attempts (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS gocardless_retry_attempt_plan_idx
  ON gocardless_payment_retry_attempts (plan_id, created_at DESC);