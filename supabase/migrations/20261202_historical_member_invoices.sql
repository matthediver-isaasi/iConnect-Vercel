-- Metadata only: never a payment, membership term or accounting recovery source.
CREATE TABLE IF NOT EXISTS public.historical_invoice_import (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenant(id),
  source_sha256 text NOT NULL CHECK (source_sha256 ~ '^[0-9a-f]{64}$'),
  worksheet text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, source_sha256, worksheet)
);
CREATE TABLE IF NOT EXISTS public.historical_member_invoice (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenant(id),
  member_id uuid NOT NULL REFERENCES public.member(id),
  import_id uuid NOT NULL REFERENCES public.historical_invoice_import(id),
  source_row integer NOT NULL CHECK (source_row > 1),
  source_key text NOT NULL,
  invoice_number text NOT NULL,
  invoice_date date NOT NULL,
  amount_minor bigint NOT NULL,
  currency text CHECK (currency IS NULL OR currency ~ '^[A-Z]{3}$'),
  description text NOT NULL DEFAULT '',
  record_kind text NOT NULL CHECK (record_kind IN ('invoice', 'credit', 'overpayment')),
  status text,
  xero_company_id text NOT NULL,
  xero_document_id uuid,
  xero_document_type text CHECK (xero_document_type IN ('Invoices', 'CreditNotes')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, source_key),
  UNIQUE (import_id, source_row),
  CHECK ((xero_document_id IS NULL) = (xero_document_type IS NULL))
);
CREATE INDEX IF NOT EXISTS historical_member_invoice_member_date
  ON public.historical_member_invoice (tenant_id, member_id, invoice_date DESC, id DESC);
CREATE TABLE IF NOT EXISTS public.historical_invoice_import_row (
  import_id uuid NOT NULL REFERENCES public.historical_invoice_import(id),
  source_row integer NOT NULL,
  outcome text NOT NULL CHECK (outcome IN ('imported', 'existing')),
  detail text NOT NULL,
  PRIMARY KEY (import_id, source_row)
);
ALTER TABLE public.historical_invoice_import ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.historical_member_invoice ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.historical_invoice_import_row ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.historical_invoice_import, public.historical_member_invoice,
  public.historical_invoice_import_row FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT ON public.historical_invoice_import, public.historical_invoice_import_row TO service_role;
GRANT SELECT, INSERT ON public.historical_member_invoice TO service_role;
GRANT UPDATE (xero_document_id, xero_document_type) ON public.historical_member_invoice TO service_role;
