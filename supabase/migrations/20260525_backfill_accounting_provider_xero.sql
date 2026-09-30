-- QuickBooks Phase 4 (Task #999): backfill accounting_provider on historical
-- Xero-only rows so that downstream code reading the generalized columns
-- (api/booking-credit-note, api/booking-invoice, bookingCancellation, etc.)
-- can resolve historical Xero records via the same fallback path used for
-- new rows.
--
-- Idempotent + safe: only touches rows that already have a xero_* identifier
-- but no accounting_provider value yet. Existing 'quickbooks' values are
-- preserved.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_name = 'booking' AND column_name = 'accounting_provider') THEN
    UPDATE booking
      SET accounting_provider = 'xero',
          accounting_invoice_id = COALESCE(accounting_invoice_id, xero_invoice_id),
          accounting_invoice_number = COALESCE(accounting_invoice_number, xero_invoice_number),
          accounting_credit_note_id = COALESCE(accounting_credit_note_id, xero_credit_note_id),
          accounting_credit_note_number = COALESCE(accounting_credit_note_number, xero_credit_note_number)
      WHERE accounting_provider IS NULL
        AND (xero_invoice_id IS NOT NULL OR xero_credit_note_id IS NOT NULL);
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_name = 'complex_event_booking' AND column_name = 'accounting_provider') THEN
    UPDATE complex_event_booking
      SET accounting_provider = 'xero',
          accounting_invoice_id = COALESCE(accounting_invoice_id, xero_invoice_id),
          accounting_invoice_number = COALESCE(accounting_invoice_number, xero_invoice_number),
          accounting_credit_note_id = COALESCE(accounting_credit_note_id, xero_credit_note_id),
          accounting_credit_note_number = COALESCE(accounting_credit_note_number, xero_credit_note_number)
      WHERE accounting_provider IS NULL
        AND (xero_invoice_id IS NOT NULL OR xero_credit_note_id IS NOT NULL);
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_name = 'organisation_membership_history' AND column_name = 'accounting_provider') THEN
    UPDATE organisation_membership_history
      SET accounting_provider = 'xero',
          accounting_invoice_id = COALESCE(accounting_invoice_id, xero_invoice_id),
          accounting_invoice_number = COALESCE(accounting_invoice_number, xero_invoice_number)
      WHERE accounting_provider IS NULL
        AND xero_invoice_id IS NOT NULL;
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_name = 'member_membership_history' AND column_name = 'accounting_provider') THEN
    UPDATE member_membership_history
      SET accounting_provider = 'xero',
          accounting_invoice_id = COALESCE(accounting_invoice_id, xero_invoice_id),
          accounting_invoice_number = COALESCE(accounting_invoice_number, xero_invoice_number)
      WHERE accounting_provider IS NULL
        AND xero_invoice_id IS NOT NULL;
  END IF;
END $$;
