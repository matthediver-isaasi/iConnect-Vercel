-- Task #990: cron Pay-by-card/Submit-PO email flow.
-- When the auto-renewal cron mints a membership_fee_token (because no PO is on
-- file at renewal time) we still create the Xero invoice up front so the same
-- token can later (a) push the submitted PO into the Xero invoice Reference
-- field, and (b) show the payer the Xero invoice link on the confirmation
-- screen. These columns let the token carry that pre-created invoice.

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'membership_fee_token'
      AND column_name = 'xero_invoice_id'
  ) THEN
    ALTER TABLE membership_fee_token ADD COLUMN xero_invoice_id TEXT;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'membership_fee_token'
      AND column_name = 'xero_invoice_number'
  ) THEN
    ALTER TABLE membership_fee_token ADD COLUMN xero_invoice_number TEXT;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'membership_fee_token'
      AND column_name = 'xero_online_invoice_url'
  ) THEN
    ALTER TABLE membership_fee_token ADD COLUMN xero_online_invoice_url TEXT;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'membership_fee_token'
      AND column_name = 'history_record_id'
  ) THEN
    ALTER TABLE membership_fee_token ADD COLUMN history_record_id UUID;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'membership_fee_token'
      AND column_name = 'paid_at'
  ) THEN
    ALTER TABLE membership_fee_token ADD COLUMN paid_at TIMESTAMPTZ;
  END IF;
END $$;
