CREATE TABLE IF NOT EXISTS pending_po_token (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  token TEXT NOT NULL UNIQUE,
  tenant_id UUID NOT NULL,
  invoice_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'submitted', 'expired', 'cancelled')),
  recipient_email TEXT,
  po_number TEXT,
  expires_at TIMESTAMPTZ NOT NULL,
  submitted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pending_po_token_token ON pending_po_token(token);
CREATE INDEX IF NOT EXISTS idx_pending_po_token_tenant_invoice ON pending_po_token(tenant_id, invoice_key);
