-- GoCardless Phase 5 — renewals & existing-member migration.
-- Idempotent. Apply against DEST_DATABASE_URL (pooler) via
-- scripts/apply-gocardless-phase5.mjs.

-- 1) Plan completion timestamp (evidence of the finished subscription).
ALTER TABLE membership_payment_plans
  ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ;

-- 2) Tier-level "Switch to monthly DD" migration flag.
ALTER TABLE membership_tier_config
  ADD COLUMN IF NOT EXISTS dd_migration_enabled BOOLEAN NOT NULL DEFAULT false;

-- 3) Renewal tracking: one row per (previous agreement, renewal year).
CREATE TABLE IF NOT EXISTS membership_dd_renewals (
  id BIGSERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL,
  member_id UUID NOT NULL,
  previous_agreement_id UUID NOT NULL REFERENCES membership_billing_agreements(id),
  new_agreement_id UUID REFERENCES membership_billing_agreements(id),
  renewal_year TEXT NOT NULL,
  mode TEXT NOT NULL DEFAULT 'confirm',          -- 'auto' | 'confirm'
  status TEXT NOT NULL DEFAULT 'notice_sent',    -- notice_sent | renewed | confirmed | declined | failed
  notice_sent_at TIMESTAMPTZ,
  confirmed_at TIMESTAMPTZ,
  failure_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT membership_dd_renewals_prev_year_uniq UNIQUE (previous_agreement_id, renewal_year)
);
CREATE INDEX IF NOT EXISTS idx_dd_renewals_tenant ON membership_dd_renewals(tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_dd_renewals_member ON membership_dd_renewals(tenant_id, member_id, renewal_year);

-- 4) Migration invites (existing Stripe/invoice members -> monthly DD).
CREATE TABLE IF NOT EXISTS membership_dd_migration_invites (
  id BIGSERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL,
  member_id UUID NOT NULL,
  token TEXT NOT NULL UNIQUE,
  invited_email TEXT,
  invited_by TEXT,
  switch_from_year TEXT NOT NULL,               -- membership year the DD starts from
  status TEXT NOT NULL DEFAULT 'invited',        -- invited | accepted | declined | revoked | superseded | expired
  billing_agreement_id UUID REFERENCES membership_billing_agreements(id),
  admin_notes TEXT,
  expires_at TIMESTAMPTZ NOT NULL,
  accepted_at TIMESTAMPTZ,
  declined_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_dd_migration_invites_tenant ON membership_dd_migration_invites(tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_dd_migration_invites_member ON membership_dd_migration_invites(tenant_id, member_id);
