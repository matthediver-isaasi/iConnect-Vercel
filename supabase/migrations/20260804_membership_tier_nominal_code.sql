-- Task 3339: per-tier nominal code override on membership invoices.
-- Adds an optional account/nominal code to the flat tier config and to each
-- tier band. When set, it overrides the global membership_nominal_ledger
-- system setting on membership invoice lines (Xero AccountCode / QBO Item).
-- Idempotent — safe to re-run.

ALTER TABLE membership_tier_config ADD COLUMN IF NOT EXISTS nominal_code TEXT;
ALTER TABLE membership_tier_band ADD COLUMN IF NOT EXISTS nominal_code TEXT;
