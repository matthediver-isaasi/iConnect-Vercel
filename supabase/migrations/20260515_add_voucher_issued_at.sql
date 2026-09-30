-- Add issued_at to voucher so the training voucher transactions CSV export
-- can include "Voucher awarded" rows when a date-range filter is active.
-- Backfill existing rows from the earliest related voucher_transaction.created_at
-- (falling back to now() for vouchers that have no transactions yet).

ALTER TABLE voucher
  ADD COLUMN IF NOT EXISTS issued_at timestamptz;

UPDATE voucher v
SET issued_at = COALESCE(
  (SELECT MIN(vt.created_at)
     FROM voucher_transaction vt
    WHERE vt.voucher_id = v.id),
  now()
)
WHERE v.issued_at IS NULL;

ALTER TABLE voucher
  ALTER COLUMN issued_at SET DEFAULT now();

ALTER TABLE voucher
  ALTER COLUMN issued_at SET NOT NULL;
