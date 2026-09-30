-- Task #1131: tokenised public "View Invoice" PDF fallback for QBO renewal emails.
--
-- QBO only returns a customer-facing InvoiceLink when the company file has
-- online invoicing enabled. Tenants without it currently receive renewal
-- emails with no link at all. This table mints an opaque token per
-- membership history row so the renewal email can fall back to a public
-- PDF endpoint when no provider-hosted link is available.

CREATE TABLE IF NOT EXISTS membership_invoice_pdf_token (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  token TEXT NOT NULL UNIQUE,
  tenant_id UUID NOT NULL,
  history_table TEXT NOT NULL CHECK (history_table IN ('organisation_membership_history', 'member_membership_history')),
  history_row_id UUID NOT NULL,
  revoked BOOLEAN NOT NULL DEFAULT FALSE,
  access_count INTEGER NOT NULL DEFAULT 0,
  last_accessed_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- One token per (tenant, table, row) so re-sending the email reuses the URL.
CREATE UNIQUE INDEX IF NOT EXISTS idx_membership_invoice_pdf_token_row
  ON membership_invoice_pdf_token (tenant_id, history_table, history_row_id);

CREATE INDEX IF NOT EXISTS idx_membership_invoice_pdf_token_token
  ON membership_invoice_pdf_token (token);
