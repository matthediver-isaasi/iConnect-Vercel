-- Task: Membership invoice add-on line items
-- Adds a JSONB column storing add-on lines (training fund / free-form)
-- captured at fee-approval time, appended to the accounting invoice at
-- invoice-creation time. Idempotent.

ALTER TABLE organisation_membership_invoicing
  ADD COLUMN IF NOT EXISTS addon_lines JSONB;
