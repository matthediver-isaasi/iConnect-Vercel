-- GoCardless Phase 2 — individual membership monthly Direct Debit config.
-- Idempotent: safe to re-run.
--
-- Adds Direct Debit configuration to membership tier structures:
--   membership_tier_config — DD policy fields (enabled, instalment count,
--     first-collection rule, collection day, activation rule, auto-renew,
--     grace days, terms version, flat monthly amount for flat pricing)
--   membership_tier_band   — per-band explicit monthly instalment amount
--   membership_payment_plans — instalments_total (subscription count)

ALTER TABLE membership_tier_config
  ADD COLUMN IF NOT EXISTS dd_enabled BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS dd_instalment_count INTEGER NOT NULL DEFAULT 12,
  ADD COLUMN IF NOT EXISTS dd_monthly_amount NUMERIC(12,2),
  ADD COLUMN IF NOT EXISTS dd_first_collection_rule TEXT NOT NULL DEFAULT 'earliest',
  ADD COLUMN IF NOT EXISTS dd_collection_day INTEGER,
  ADD COLUMN IF NOT EXISTS dd_activation_rule TEXT NOT NULL DEFAULT 'first_payment',
  ADD COLUMN IF NOT EXISTS dd_auto_renew BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS dd_grace_days INTEGER NOT NULL DEFAULT 7,
  ADD COLUMN IF NOT EXISTS dd_terms_version TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'membership_tier_config_dd_first_collection_rule_check'
  ) THEN
    ALTER TABLE membership_tier_config
      ADD CONSTRAINT membership_tier_config_dd_first_collection_rule_check
      CHECK (dd_first_collection_rule IN ('earliest', 'nominated_day', 'anniversary'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'membership_tier_config_dd_activation_rule_check'
  ) THEN
    ALTER TABLE membership_tier_config
      ADD CONSTRAINT membership_tier_config_dd_activation_rule_check
      CHECK (dd_activation_rule IN ('mandate', 'first_payment', 'manual'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'membership_tier_config_dd_collection_day_check'
  ) THEN
    ALTER TABLE membership_tier_config
      ADD CONSTRAINT membership_tier_config_dd_collection_day_check
      CHECK (dd_collection_day IS NULL OR (dd_collection_day >= 1 AND dd_collection_day <= 28));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'membership_tier_config_dd_instalment_count_check'
  ) THEN
    ALTER TABLE membership_tier_config
      ADD CONSTRAINT membership_tier_config_dd_instalment_count_check
      CHECK (dd_instalment_count >= 1 AND dd_instalment_count <= 12);
  END IF;
END $$;

ALTER TABLE membership_tier_band
  ADD COLUMN IF NOT EXISTS dd_monthly_amount NUMERIC(12,2);

ALTER TABLE membership_payment_plans
  ADD COLUMN IF NOT EXISTS instalments_total INTEGER;

-- Link a member's membership-year record to the Direct Debit agreement that
-- is paying for it. Status values used by DD rows:
--   'pending_payment_setup' — DD chosen, mandate not yet active
--   'pending_activation'    — mandate/payment received, awaiting admin (manual rule)
--   'active'                — activated per the tier's dd_activation_rule
ALTER TABLE member_membership_history
  ADD COLUMN IF NOT EXISTS billing_agreement_id UUID REFERENCES membership_billing_agreements(id);
CREATE INDEX IF NOT EXISTS member_membership_history_billing_agreement_idx
  ON member_membership_history (billing_agreement_id)
  WHERE billing_agreement_id IS NOT NULL;
