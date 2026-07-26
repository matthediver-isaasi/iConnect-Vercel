-- Task #3117 Phase 2: Monthly voucher balance rollup & snapshots.
--
-- Immutable month-end voucher position per organisation:
--   opening + allocated + adjustments_positive + reinstated
--     - used - expired - adjustments_negative = closing
-- month is the first day of the calendar month (UTC).
-- One row per (tenant, organization, month); closing balance for month N
-- carries forward as opening balance for month N+1.

CREATE TABLE IF NOT EXISTS voucher_monthly_snapshot (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  organization_id uuid NOT NULL,
  month date NOT NULL,
  opening_balance numeric NOT NULL DEFAULT 0,
  allocated numeric NOT NULL DEFAULT 0,
  used numeric NOT NULL DEFAULT 0,
  expired numeric NOT NULL DEFAULT 0,
  adjustments_positive numeric NOT NULL DEFAULT 0,
  adjustments_negative numeric NOT NULL DEFAULT 0,
  reinstated numeric NOT NULL DEFAULT 0,
  closing_balance numeric NOT NULL DEFAULT 0,
  reserved_future numeric NOT NULL DEFAULT 0,
  available_balance numeric NOT NULL DEFAULT 0,
  generated_at timestamptz NOT NULL DEFAULT now(),
  generated_by text
);

CREATE UNIQUE INDEX IF NOT EXISTS voucher_monthly_snapshot_unique
  ON voucher_monthly_snapshot (tenant_id, organization_id, month);

CREATE INDEX IF NOT EXISTS voucher_monthly_snapshot_tenant_month
  ON voucher_monthly_snapshot (tenant_id, month);
