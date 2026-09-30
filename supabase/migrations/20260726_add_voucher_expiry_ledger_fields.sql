-- Task #3116 Phase 1: Voucher expiry ledger & allocation metadata.
--
-- 1. Allocation metadata on voucher: valid_from (when the voucher becomes
--    usable, informational for finance), funding_source (source/reason for
--    the allocation), notes (free text), created_by (email of the admin who
--    created the allocation).
-- 2. notes on voucher_transaction: used by the new `expiry` ledger entries
--    (original/used/remaining breakdown) and to record manual voucher
--    selection overrides on booking_usage rows.
--
-- All statements are idempotent; the voucher_transaction.type column is free
-- text so the new `expiry` type needs no DDL.

ALTER TABLE voucher
  ADD COLUMN IF NOT EXISTS valid_from timestamptz;

ALTER TABLE voucher
  ADD COLUMN IF NOT EXISTS funding_source text;

ALTER TABLE voucher
  ADD COLUMN IF NOT EXISTS notes text;

ALTER TABLE voucher
  ADD COLUMN IF NOT EXISTS created_by text;

ALTER TABLE voucher_transaction
  ADD COLUMN IF NOT EXISTS notes text;
