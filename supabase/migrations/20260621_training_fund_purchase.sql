-- Task #1660: Buy Training Funds (Stripe / Invoice) with pending balance.
--
-- Adds a `training_fund_purchase` table tracking each self-serve top-up of an
-- organisation's Training Fund balance: amount, payment method (card/invoice),
-- purchase order number (+ "to follow" flag), status (pending/paid/cancelled),
-- Stripe payment reference, and accounting invoice ids (dual-write generic
-- `accounting_invoice_id` + legacy `xero_invoice_id`, mirroring the membership
-- invoice columns).
--
-- Also adds `training_fund_pending_balance` to `organization` to track funds
-- bought by invoice but not yet confirmed paid. Card purchases never touch this
-- column; they credit `training_fund_balance` directly on payment success.
--
-- Idempotent — safe to re-run.

CREATE TABLE IF NOT EXISTS training_fund_purchase (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  organization_id uuid NOT NULL,
  amount numeric NOT NULL,
  payment_method text NOT NULL,
  purchase_order_number text,
  po_to_follow boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'pending',
  stripe_payment_intent_id text,
  accounting_provider text,
  accounting_invoice_id text,
  accounting_invoice_number text,
  xero_invoice_id text,
  xero_invoice_number text,
  online_invoice_url text,
  transaction_id uuid,
  created_by uuid,
  created_date timestamptz NOT NULL DEFAULT now(),
  paid_at timestamptz
);

-- Payment method / status guard constraints (added defensively).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'training_fund_purchase_payment_method_check'
  ) THEN
    ALTER TABLE training_fund_purchase
      ADD CONSTRAINT training_fund_purchase_payment_method_check
      CHECK (payment_method IN ('card', 'invoice'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'training_fund_purchase_status_check'
  ) THEN
    ALTER TABLE training_fund_purchase
      ADD CONSTRAINT training_fund_purchase_status_check
      CHECK (status IN ('pending', 'paid', 'cancelled'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_training_fund_purchase_tenant ON training_fund_purchase(tenant_id);
CREATE INDEX IF NOT EXISTS idx_training_fund_purchase_org ON training_fund_purchase(organization_id);
CREATE INDEX IF NOT EXISTS idx_training_fund_purchase_status ON training_fund_purchase(status);
-- The reconciliation cron scans pending invoice-method rows oldest-first.
CREATE INDEX IF NOT EXISTS idx_training_fund_purchase_pending_invoice
  ON training_fund_purchase(created_date)
  WHERE status = 'pending' AND payment_method = 'invoice';

-- Pending balance on organisation (funds bought by invoice, not yet paid).
ALTER TABLE organization
  ADD COLUMN IF NOT EXISTS training_fund_pending_balance numeric NOT NULL DEFAULT 0;

-- Atomic pending-balance increment (used when an invoice purchase is created).
-- Clamps at zero so a decrement can never drive the column negative.
CREATE OR REPLACE FUNCTION increment_org_training_fund_pending(
  p_org_id uuid,
  p_delta numeric
) RETURNS numeric
LANGUAGE plpgsql
AS $$
DECLARE
  v_new numeric;
BEGIN
  UPDATE organization
     SET training_fund_pending_balance = GREATEST(0, COALESCE(training_fund_pending_balance, 0) + p_delta)
   WHERE id = p_org_id
  RETURNING training_fund_pending_balance INTO v_new;
  RETURN v_new;
END;
$$;

-- Atomically claim a pending purchase and credit the organisation's available
-- balance, writing the ledger row, all in a single transaction. The claim is a
-- compare-and-set on status (pending -> paid): the row-level lock from the
-- UPDATE serialises concurrent callers, and the balance is mutated with an
-- in-place expression (col = col + amount) so concurrent credits for the same
-- org cannot lose updates.
--
-- Returns jsonb: { credited: bool, reason?: text, amount?: numeric,
--                  balance_after?: numeric, transaction_id?: uuid }
CREATE OR REPLACE FUNCTION credit_training_fund_purchase(
  p_purchase_id uuid,
  p_paid_at timestamptz DEFAULT now(),
  p_source text DEFAULT 'purchase'
) RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_purchase training_fund_purchase%ROWTYPE;
  v_amount numeric;
  v_balance_before numeric;
  v_balance_after numeric;
  v_reason text;
  v_txn_id uuid;
BEGIN
  -- Compare-and-set: claim the row only if still pending. The UPDATE takes a
  -- row lock; a concurrent caller blocks here then finds status <> 'pending'.
  UPDATE training_fund_purchase
     SET status = 'paid', paid_at = COALESCE(p_paid_at, now())
   WHERE id = p_purchase_id
     AND status = 'pending'
  RETURNING * INTO v_purchase;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('credited', false, 'reason', 'already-processed-or-missing');
  END IF;

  v_amount := COALESCE(v_purchase.amount, 0);

  -- Credit the available balance atomically and (for invoice purchases) draw
  -- the same amount down from the pending figure.
  IF v_purchase.payment_method = 'invoice' THEN
    UPDATE organization
       SET training_fund_balance = COALESCE(training_fund_balance, 0) + v_amount,
           training_fund_pending_balance = GREATEST(0, COALESCE(training_fund_pending_balance, 0) - v_amount)
     WHERE id = v_purchase.organization_id
    RETURNING COALESCE(training_fund_balance, 0) - v_amount, COALESCE(training_fund_balance, 0)
      INTO v_balance_before, v_balance_after;
  ELSE
    UPDATE organization
       SET training_fund_balance = COALESCE(training_fund_balance, 0) + v_amount
     WHERE id = v_purchase.organization_id
    RETURNING COALESCE(training_fund_balance, 0) - v_amount, COALESCE(training_fund_balance, 0)
      INTO v_balance_before, v_balance_after;
  END IF;

  IF NOT FOUND THEN
    -- Org vanished; abort the whole transaction so the claim is rolled back too.
    RAISE EXCEPTION 'organisation % not found while crediting purchase %', v_purchase.organization_id, p_purchase_id;
  END IF;

  v_reason := CASE WHEN v_purchase.payment_method = 'card'
                   THEN 'Training fund top-up (card payment)'
                   ELSE 'Training fund top-up (invoice paid)' END;

  INSERT INTO training_fund_transaction (
    tenant_id, organization_id, type, amount,
    balance_before, balance_after, reason, created_by, created_date
  ) VALUES (
    v_purchase.tenant_id, v_purchase.organization_id, 'purchase', v_amount,
    v_balance_before, v_balance_after, v_reason, v_purchase.created_by,
    COALESCE(p_paid_at, now())
  ) RETURNING id INTO v_txn_id;

  UPDATE training_fund_purchase SET transaction_id = v_txn_id WHERE id = p_purchase_id;

  RETURN jsonb_build_object(
    'credited', true,
    'amount', v_amount,
    'balance_after', v_balance_after,
    'transaction_id', v_txn_id
  );
END;
$$;
