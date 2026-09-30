-- Widen training_fund_transaction_type_check to allow 'purchase'.
--
-- The Postgres function `credit_training_fund_purchase` (see
-- 20260621_training_fund_purchase.sql) inserts a ledger row with
-- type='purchase', but the original check constraint only allowed
-- 'add', 'deduct', 'booking_usage'. The insert failed, rolling back the
-- whole credit transaction, so paid invoice top-ups were never released
-- to the organisation's available balance.
--
-- Idempotent — safe to re-run.

DO $$
DECLARE
  v_def text;
BEGIN
  SELECT pg_get_constraintdef(oid) INTO v_def
    FROM pg_constraint
   WHERE conname = 'training_fund_transaction_type_check'
     AND conrelid = 'training_fund_transaction'::regclass;

  IF v_def IS NULL OR v_def NOT LIKE '%purchase%' THEN
    IF v_def IS NOT NULL THEN
      ALTER TABLE training_fund_transaction
        DROP CONSTRAINT training_fund_transaction_type_check;
    END IF;

    ALTER TABLE training_fund_transaction
      ADD CONSTRAINT training_fund_transaction_type_check
      CHECK (type IN ('add', 'deduct', 'booking_usage', 'purchase'));
  END IF;
END $$;
