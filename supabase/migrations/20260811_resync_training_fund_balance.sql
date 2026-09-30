-- Training fund balance resync: admin-only repair path for organisations
-- whose stored organization.training_fund_balance has drifted from the sum
-- of training_fund_transaction ledger rows.
--
-- The function locks the org row, recomputes the ledger-derived balance with
-- EXACTLY the same logic as the drift-summary endpoint (opening = earliest
-- transaction's balance_before; per-row delta = balance_after -
-- balance_before when both are present, else the type-signed amount), sets
-- the stored balance to it, and records a zero-delta 'resync' audit row.
--
-- The audit row carries balance_before = balance_after = the ledger-derived
-- value (delta 0), so it documents the correction (before/after/actor in the
-- reason text and created_by) WITHOUT shifting the ledger sum — a resynced
-- org can never read as drifted because of its own reconciliation record.
--
-- Idempotent — safe to re-run. Apply to the DEST database.

-- Allow the 'resync' audit type in the ledger type check constraint.
DO $$
DECLARE
  v_def text;
BEGIN
  SELECT pg_get_constraintdef(oid) INTO v_def
    FROM pg_constraint
   WHERE conrelid = 'training_fund_transaction'::regclass
     AND conname = 'training_fund_transaction_type_check';

  IF v_def IS NULL OR v_def NOT LIKE '%resync%' THEN
    IF v_def IS NOT NULL THEN
      ALTER TABLE training_fund_transaction
        DROP CONSTRAINT training_fund_transaction_type_check;
    END IF;
    ALTER TABLE training_fund_transaction
      ADD CONSTRAINT training_fund_transaction_type_check
      CHECK (type = ANY (ARRAY['add'::text, 'deduct'::text, 'booking_usage'::text, 'purchase'::text, 'resync'::text]));
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION resync_training_fund_balance(
  p_tenant_id uuid,
  p_org_id uuid,
  p_created_by uuid DEFAULT NULL,
  p_dry_run boolean DEFAULT false
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_stored numeric;
  v_opening numeric := 0;
  v_deltas numeric := 0;
  v_ledger numeric;
  v_diff numeric;
  v_txn_id uuid;
BEGIN
  -- Lock the org row so concurrent balance writers (bookings, adjustments)
  -- serialize against the resync. For a dry run we still read under the
  -- lock briefly to get a consistent preview.
  SELECT COALESCE(training_fund_balance, 0)
    INTO v_stored
    FROM organization
   WHERE id = p_org_id
     AND tenant_id = p_tenant_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('resynced', false, 'reason', 'org-not-found');
  END IF;

  -- Mirror the drift-summary computation exactly.
  SELECT
    COALESCE((
      SELECT COALESCE(t.balance_before, 0)
        FROM training_fund_transaction t
       WHERE t.tenant_id = p_tenant_id
         AND t.organization_id = p_org_id
       ORDER BY t.created_date ASC, t.id ASC
       LIMIT 1
    ), 0),
    COALESCE((
      SELECT SUM(
        CASE
          WHEN t.balance_before IS NOT NULL AND t.balance_after IS NOT NULL
            THEN t.balance_after - t.balance_before
          ELSE (CASE WHEN t.type = 'add' THEN 1 ELSE -1 END) * ABS(COALESCE(t.amount, 0))
        END
      )
        FROM training_fund_transaction t
       WHERE t.tenant_id = p_tenant_id
         AND t.organization_id = p_org_id
    ), 0)
    INTO v_opening, v_deltas;

  v_ledger := v_opening + v_deltas;
  v_diff := v_stored - v_ledger;

  IF ABS(v_diff) <= 0.005 THEN
    RETURN jsonb_build_object(
      'resynced', false,
      'reason', 'in-sync',
      'stored_balance', v_stored,
      'ledger_balance', v_ledger,
      'difference', v_diff
    );
  END IF;

  IF p_dry_run THEN
    RETURN jsonb_build_object(
      'resynced', false,
      'reason', 'dry-run',
      'stored_balance', v_stored,
      'ledger_balance', v_ledger,
      'difference', v_diff
    );
  END IF;

  UPDATE organization
     SET training_fund_balance = v_ledger
   WHERE id = p_org_id
     AND tenant_id = p_tenant_id;

  -- Zero-delta reconciliation record: auditable, never distorts drift math.
  INSERT INTO training_fund_transaction (
    tenant_id, organization_id, type, amount,
    balance_before, balance_after, reason, created_by, created_date
  ) VALUES (
    p_tenant_id, p_org_id, 'resync', 0,
    v_ledger, v_ledger,
    'Balance resync: stored balance £' || to_char(v_stored, 'FM999999990.00')
      || ' corrected to ledger-derived £' || to_char(v_ledger, 'FM999999990.00')
      || ' (difference £' || to_char(v_diff, 'FM999999990.00') || ')',
    p_created_by, now()
  ) RETURNING id INTO v_txn_id;

  RETURN jsonb_build_object(
    'resynced', true,
    'stored_balance', v_stored,
    'ledger_balance', v_ledger,
    'difference', v_diff,
    'transaction_id', v_txn_id
  );
END;
$$;

-- SECURITY DEFINER lockdown: this function takes arbitrary tenant/org ids
-- and writes balances, so it must only be callable by the backend service
-- role (the admin endpoint enforces tenant-admin access before calling it).
-- Postgres grants EXECUTE to PUBLIC by default — revoke it explicitly.
REVOKE EXECUTE ON FUNCTION resync_training_fund_balance(uuid, uuid, uuid, boolean) FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE EXECUTE ON FUNCTION resync_training_fund_balance(uuid, uuid, uuid, boolean) FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE EXECUTE ON FUNCTION resync_training_fund_balance(uuid, uuid, uuid, boolean) FROM authenticated;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT EXECUTE ON FUNCTION resync_training_fund_balance(uuid, uuid, uuid, boolean) TO service_role;
  END IF;
END;
$$;
