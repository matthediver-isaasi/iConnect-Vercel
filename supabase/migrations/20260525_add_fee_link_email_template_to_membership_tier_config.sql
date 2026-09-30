-- Task #995: Configurable fee-link email template
--
-- Lets each tier pick a custom email_template for the Pay-by-card /
-- Submit-PO email minted by api/_lib/membershipFeeTokenEmail.js. When NULL,
-- the legacy hard-coded HTML in membershipFeeTokenEmail.js is used as the
-- system default, preserving current behaviour for existing tenants.
--
-- The chosen template body MUST contain {{payment_link}} — the API rejects
-- saves that violate this, since the recipient would otherwise have no way
-- to pay the invoice.

ALTER TABLE membership_tier_config
  ADD COLUMN IF NOT EXISTS fee_link_email_template_id uuid
  REFERENCES email_template(id) ON DELETE SET NULL;

NOTIFY pgrst, 'reload schema';
