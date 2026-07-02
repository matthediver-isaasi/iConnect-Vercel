-- Add booking_source discriminator to cancellation and transfer request tables
-- so the system knows whether to look up from 'booking' or 'complex_event_booking'

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'booking_cancellation_request' AND column_name = 'booking_source') THEN
        ALTER TABLE booking_cancellation_request ADD COLUMN booking_source TEXT DEFAULT 'booking';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'booking_transfer_request' AND column_name = 'booking_source') THEN
        ALTER TABLE booking_transfer_request ADD COLUMN booking_source TEXT DEFAULT 'booking';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'complex_event_booking' AND column_name = 'xero_invoice_id') THEN
        ALTER TABLE complex_event_booking ADD COLUMN xero_invoice_id TEXT;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'complex_event_booking' AND column_name = 'xero_invoice_number') THEN
        ALTER TABLE complex_event_booking ADD COLUMN xero_invoice_number TEXT;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'complex_event_booking' AND column_name = 'xero_credit_note_id') THEN
        ALTER TABLE complex_event_booking ADD COLUMN xero_credit_note_id TEXT;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'complex_event_booking' AND column_name = 'xero_credit_note_number') THEN
        ALTER TABLE complex_event_booking ADD COLUMN xero_credit_note_number TEXT;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'complex_event_booking' AND column_name = 'discount_code_id') THEN
        ALTER TABLE complex_event_booking ADD COLUMN discount_code_id UUID;
    END IF;
END $$;

COMMENT ON COLUMN booking_cancellation_request.booking_source IS 'Source table for the booking: booking or complex_event_booking';
COMMENT ON COLUMN booking_transfer_request.booking_source IS 'Source table for the booking: booking or complex_event_booking';
