-- One provider-pinned invoice creation journal shared by browser and webhook.
ALTER TABLE public.member_membership_history
  ADD COLUMN IF NOT EXISTS accounting_online_invoice_url text,
  ADD COLUMN IF NOT EXISTS xero_online_invoice_url text;
ALTER TABLE public.organisation_membership_history
  ADD COLUMN IF NOT EXISTS accounting_online_invoice_url text,
  ADD COLUMN IF NOT EXISTS xero_online_invoice_url text;
CREATE TABLE IF NOT EXISTS public.membership_reminder_accounting (
  tenant_id uuid NOT NULL,
  history_record_id uuid NOT NULL,
  provider text NOT NULL CHECK (provider IN ('xero', 'quickbooks')),
  stripe_payment_intent_id text NOT NULL,
  accounting_provider text,
  accounting_invoice_id text,
  accounting_invoice_number text,
  accounting_online_invoice_url text,
  xero_invoice_id text,
  xero_invoice_number text,
  xero_online_invoice_url text,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, history_record_id),
  UNIQUE (tenant_id, stripe_payment_intent_id)
);
ALTER TABLE public.membership_reminder_accounting ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.membership_reminder_accounting FROM anon, authenticated;
GRANT ALL ON public.membership_reminder_accounting TO service_role;