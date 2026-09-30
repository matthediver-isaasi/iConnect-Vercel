-- Task #993: Unified membership email recipients
--
-- Replace the split-brain recipient config (invoice_email_field_name +
-- invoice_recipient_role_ids) with a single jsonb shape:
--   { invoicing_email: bool, primary_contact: bool, role_ids: uuid[] }
--
-- The two pseudo-entries (invoicing_email, primary_contact) sit alongside the
-- real member roles in one unified picker. Both the legacy invoice-email path
-- (membershipInvoiceEmail.js) and the new no-PO fee-token path
-- (membershipFeeTokenEmail.js) now resolve recipients through one shared
-- helper that reads this column.
--
-- Backfill rules (preserve current behaviour for existing tenants):
--   * invoice_email_field_name = 'invoicing_email'
--       -> { invoicing_email: true, primary_contact: false, role_ids: [...] }
--   * invoice_email_field_name = NULL (default: invoicing email then primary contact)
--       -> { invoicing_email: true, primary_contact: true, role_ids: [...] }
--
-- The old columns are kept readable for one release as a safety net; new
-- writes go to invoice_recipients only.

ALTER TABLE membership_tier_config
  ADD COLUMN IF NOT EXISTS invoice_recipients jsonb;

UPDATE membership_tier_config
SET invoice_recipients = jsonb_build_object(
  'invoicing_email', true,
  'primary_contact', CASE WHEN invoice_email_field_name = 'invoicing_email' THEN false ELSE true END,
  'role_ids', COALESCE(to_jsonb(invoice_recipient_role_ids), '[]'::jsonb)
)
WHERE invoice_recipients IS NULL;

NOTIFY pgrst, 'reload schema';
