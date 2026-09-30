-- Track scheduled pending-PO chase reminders so the cron can throttle sends
-- (send-after-days, repeat-every-days, max-sends) and avoid duplicate sends on
-- the same day. Idempotent.

CREATE TABLE IF NOT EXISTS po_reminder_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  invoice_key text NOT NULL,
  recipient_email text,
  sent_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Lookups are always scoped to a tenant + invoice, most recent first.
CREATE INDEX IF NOT EXISTS idx_po_reminder_log_tenant_invoice
  ON po_reminder_log (tenant_id, invoice_key);

CREATE INDEX IF NOT EXISTS idx_po_reminder_log_tenant_invoice_sent
  ON po_reminder_log (tenant_id, invoice_key, sent_at DESC);
