-- Backfill any NULL tenant_id rows on fund-related transaction tables and
-- enforce NOT NULL going forward. The two insert sites that previously fell
-- back to `tenant_id || null` (one-off event booking) caused at least one
-- orphan row that was silently excluded from the per-org reconciliation.

UPDATE training_fund_transaction t
SET tenant_id = o.tenant_id
FROM organization o
WHERE t.organization_id = o.id
  AND t.tenant_id IS NULL
  AND o.tenant_id IS NOT NULL;

UPDATE voucher_transaction vt
SET tenant_id = o.tenant_id
FROM organization o
WHERE vt.organization_id = o.id
  AND vt.tenant_id IS NULL
  AND o.tenant_id IS NOT NULL;

ALTER TABLE training_fund_transaction
  ALTER COLUMN tenant_id SET NOT NULL;

ALTER TABLE voucher_transaction
  ALTER COLUMN tenant_id SET NOT NULL;
