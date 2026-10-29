BEGIN;
ALTER TABLE public.public_invoice_po_billing
 ADD COLUMN email_status text NOT NULL DEFAULT 'legacy_review'
 CHECK(email_status IN ('legacy_review','pending','preparing','sending','sent','sent_external','unknown','needs_review')),
 ADD COLUMN email_next_at timestamptz NOT NULL DEFAULT now(),
 ADD COLUMN email_lease uuid,
 ADD COLUMN email_lease_until timestamptz,
 ADD COLUMN email_sent_at timestamptz,
 ADD COLUMN email_message_id text,
 ADD COLUMN email_error text;
-- Historical approvals are not permission to bulk-email old invoices.
ALTER TABLE public.public_invoice_po_billing ALTER COLUMN email_status SET DEFAULT 'pending';
GRANT UPDATE(email_status,email_next_at,email_lease,email_lease_until,email_sent_at,email_message_id,email_error)
 ON public.public_invoice_po_billing TO service_role;
CREATE INDEX public_po_email_due ON public.public_invoice_po_billing(email_next_at,id)
 WHERE email_status IN ('pending','preparing','sending');
NOTIFY pgrst,'reload schema';
COMMIT;
