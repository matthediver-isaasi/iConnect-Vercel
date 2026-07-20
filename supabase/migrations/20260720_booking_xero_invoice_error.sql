-- Adds a lightweight failure marker for the post-booking Xero invoice flow.
-- When the (best-effort, error-swallowing) invoice creation fails for a
-- booking with a balance due, the error summary is recorded here so admins
-- can spot bookings whose invoice never generated. Cleared when an invoice
-- is successfully created. Idempotent.
ALTER TABLE booking ADD COLUMN IF NOT EXISTS xero_invoice_error text;
