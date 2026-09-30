-- Annual membership renewal lifecycle. These fields belong to each dated tier
-- snapshot and are intentionally separate from monthly DD/card arrears fields.
ALTER TABLE membership_tier_config
  ADD COLUMN IF NOT EXISTS renewal_open_days INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS renewal_grace_days INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS renewal_disable_login BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS renewal_change_role BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS renewal_fallback_role_id UUID;

ALTER TABLE member_membership_history
  ADD COLUMN IF NOT EXISTS term_start_date DATE,
  ADD COLUMN IF NOT EXISTS term_end_date DATE,
  ADD COLUMN IF NOT EXISTS annual_renewal_state TEXT,
  ADD COLUMN IF NOT EXISTS annual_renewal_processed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS annual_renewal_idempotency_key TEXT,
  ADD COLUMN IF NOT EXISTS expiry_enforced_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS expiry_enforcement_key TEXT,
  ADD COLUMN IF NOT EXISTS scheduled_activation_date DATE;

ALTER TABLE organisation_membership_history
  ADD COLUMN IF NOT EXISTS term_start_date DATE,
  ADD COLUMN IF NOT EXISTS term_end_date DATE,
  ADD COLUMN IF NOT EXISTS annual_renewal_state TEXT,
  ADD COLUMN IF NOT EXISTS annual_renewal_processed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS annual_renewal_idempotency_key TEXT,
  ADD COLUMN IF NOT EXISTS expiry_enforced_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS expiry_enforcement_key TEXT;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'membership_tier_config_renewal_open_days_check') THEN
    ALTER TABLE membership_tier_config ADD CONSTRAINT membership_tier_config_renewal_open_days_check
      CHECK (renewal_open_days BETWEEN 0 AND 366);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'membership_tier_config_renewal_grace_days_check') THEN
    ALTER TABLE membership_tier_config ADD CONSTRAINT membership_tier_config_renewal_grace_days_check
      CHECK (renewal_grace_days BETWEEN 0 AND 366);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'member_membership_history_annual_renewal_state_check') THEN
    ALTER TABLE member_membership_history ADD CONSTRAINT member_membership_history_annual_renewal_state_check
      CHECK (annual_renewal_state IS NULL OR annual_renewal_state IN ('renewable_soon', 'open', 'grace', 'renewed', 'expired'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'organisation_membership_history_annual_renewal_state_check') THEN
    ALTER TABLE organisation_membership_history ADD CONSTRAINT organisation_membership_history_annual_renewal_state_check
      CHECK (annual_renewal_state IS NULL OR annual_renewal_state IN ('renewable_soon', 'open', 'grace', 'renewed', 'expired'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS member_membership_history_annual_expiry_sweep_idx
  ON member_membership_history (tenant_id, term_end_date)
  WHERE expiry_enforced_at IS NULL;
CREATE INDEX IF NOT EXISTS organisation_membership_history_annual_expiry_sweep_idx
  ON organisation_membership_history (tenant_id, term_end_date)
  WHERE expiry_enforced_at IS NULL;
CREATE INDEX IF NOT EXISTS member_membership_history_scheduled_activation_idx
  ON member_membership_history (tenant_id, scheduled_activation_date)
  WHERE status = 'scheduled';

CREATE UNIQUE INDEX IF NOT EXISTS organisation_membership_history_org_year_uniq
  ON organisation_membership_history (tenant_id, organization_id, membership_year);

CREATE TABLE IF NOT EXISTS membership_expiry_action (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  history_type TEXT NOT NULL CHECK (history_type IN ('member', 'organisation')),
  history_id UUID NOT NULL,
  member_id UUID NOT NULL REFERENCES member(id) ON DELETE CASCADE,
  config_id UUID REFERENCES membership_tier_config(id) ON DELETE SET NULL,
  previous_login_enabled BOOLEAN,
  login_disabled BOOLEAN NOT NULL DEFAULT false,
  previous_role_id UUID,
  assigned_role_id UUID,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (history_type, history_id, member_id)
);
CREATE INDEX IF NOT EXISTS membership_expiry_action_tenant_member_idx
  ON membership_expiry_action (tenant_id, member_id, applied_at DESC);