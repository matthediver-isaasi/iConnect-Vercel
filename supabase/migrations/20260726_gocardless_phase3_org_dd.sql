-- GoCardless Phase 3 — organisational membership Direct Debit.
-- Idempotent: safe to re-run.
--
--   membership_billing_agreements — organisational payer model fields
--   organisation_membership_history — billing agreement link + payment status
--   membership_dd_invitations — secure-token billing-contact invitations

ALTER TABLE membership_billing_agreements
  ADD COLUMN IF NOT EXISTS primary_contact_member_id UUID,
  ADD COLUMN IF NOT EXISTS billing_contact_name TEXT,
  ADD COLUMN IF NOT EXISTS billing_contact_email TEXT,
  ADD COLUMN IF NOT EXISTS dd_payer TEXT,            -- 'self' | 'billing_contact'
  ADD COLUMN IF NOT EXISTS mandate_completed_by TEXT; -- email of whoever completed the GC flow

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'membership_billing_agreements_dd_payer_check'
  ) THEN
    ALTER TABLE membership_billing_agreements
      ADD CONSTRAINT membership_billing_agreements_dd_payer_check
      CHECK (dd_payer IS NULL OR dd_payer IN ('self', 'billing_contact'));
  END IF;
END $$;

ALTER TABLE organisation_membership_history
  ADD COLUMN IF NOT EXISTS billing_agreement_id UUID REFERENCES membership_billing_agreements(id),
  ADD COLUMN IF NOT EXISTS payment_status TEXT,
  ADD COLUMN IF NOT EXISTS paid_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS organisation_membership_history_billing_agreement_idx
  ON organisation_membership_history (billing_agreement_id)
  WHERE billing_agreement_id IS NOT NULL;

-- Billing-contact payment-setup invitations. Token is a 64-hex-char
-- crypto-random string; single-use after completion, revocable, expiring.
CREATE TABLE IF NOT EXISTS membership_dd_invitations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  organization_id UUID NOT NULL,
  billing_agreement_id UUID NOT NULL REFERENCES membership_billing_agreements(id),
  token TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending', -- pending | completed | revoked | superseded
  invited_email TEXT NOT NULL,
  invited_name TEXT,
  invited_by_member_id UUID,
  expires_at TIMESTAMPTZ NOT NULL,
  accepted_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS membership_dd_invitations_token_uniq
  ON membership_dd_invitations (token);
CREATE INDEX IF NOT EXISTS membership_dd_invitations_tenant_idx
  ON membership_dd_invitations (tenant_id);
CREATE INDEX IF NOT EXISTS membership_dd_invitations_agreement_idx
  ON membership_dd_invitations (billing_agreement_id);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'membership_dd_invitations_status_check'
  ) THEN
    ALTER TABLE membership_dd_invitations
      ADD CONSTRAINT membership_dd_invitations_status_check
      CHECK (status IN ('pending', 'completed', 'revoked', 'superseded'));
  END IF;
END $$;
