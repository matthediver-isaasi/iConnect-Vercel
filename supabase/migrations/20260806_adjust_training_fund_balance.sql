-- Prevent untracked training fund balance writes: dedicated atomic RPC for
-- admin add/deduct adjustments from /TrainingFundManagement.
--
-- Mirrors the lock-safe pattern of credit_training_fund_purchase: the balance
-- is mutated with an in-place expression under the row lock taken by UPDATE,
-- and the ledger row is written in the same transaction, so a partial failure
-- can never leave balance and ledger diverged.
--
-- Deductions are refused (not clamped) when they would drive the balance
-- below zero, so the ledger never records an impossible movement.
--
-- Idempotent — safe to re-run.

CREATE OR REPLACE FUNCTION adjust_training_fund_balance(
  p_tenant_id uuid,
  p_org_id uuid,
  p_type text,               -- 'add' | 'deduct'
  p_amount numeric,          -- positive magnitude
  p_reason text DEFAULT NULL,
  p_created_by uuid DEFAULT NULL,
  p_created_date timestamptz DEFAULT now()
) RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_delta numeric;
  v_balance_before numeric;
  v_balance_after numeric;
  v_txn_id uuid;
BEGIN
  IF p_type NOT IN ('add', 'deduct') THEN
    RETURN jsonb_build_object('adjusted', false, 'reason', 'invalid-type');
  END IF;
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RETURN jsonb_build_object('adjusted', false, 'reason', 'invalid-amount');
  END IF;

  v_delta := CASE WHEN p_type = 'add' THEN p_amount ELSE -p_amount END;

  -- In-place mutation under the row lock; the WHERE clause refuses a
  -- deduction that would take the balance negative.
  UPDATE organization
     SET training_fund_balance = COALESCE(training_fund_balance, 0) + v_delta
   WHERE id = p_org_id
     AND tenant_id = p_tenant_id
     AND COALESCE(training_fund_balance, 0) + v_delta >= 0
  RETURNING COALESCE(training_fund_balance, 0) - v_delta, COALESCE(training_fund_balance, 0)
    INTO v_balance_before, v_balance_after;

  IF NOT FOUND THEN
    -- Distinguish missing org from insufficient balance for a clearer error.
    IF EXISTS (SELECT 1 FROM organization WHERE id = p_org_id AND tenant_id = p_tenant_id) THEN
      RETURN jsonb_build_object('adjusted', false, 'reason', 'insufficient-balance');
    END IF;
    RETURN jsonb_build_object('adjusted', false, 'reason', 'org-not-found');
  END IF;

  INSERT INTO training_fund_transaction (
    tenant_id, organization_id, type, amount,
    balance_before, balance_after, reason, created_by, created_date
  ) VALUES (
    p_tenant_id, p_org_id, p_type, p_amount,
    v_balance_before, v_balance_after,
    COALESCE(NULLIF(p_reason, ''), CASE WHEN p_type = 'add' THEN 'Funds added' ELSE 'Funds deducted' END),
    p_created_by, COALESCE(p_created_date, now())
  ) RETURNING id INTO v_txn_id;

  RETURN jsonb_build_object(
    'adjusted', true,
    'balance_before', v_balance_before,
    'balance_after', v_balance_after,
    'transaction_id', v_txn_id
  );
END;
$$;
