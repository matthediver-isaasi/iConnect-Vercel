-- Add Xero invoice columns and PO fields to complex_event_booking
-- These bring complex event bookings to financial parity with single event bookings

ALTER TABLE complex_event_booking
  ADD COLUMN IF NOT EXISTS xero_invoice_id TEXT,
  ADD COLUMN IF NOT EXISTS xero_invoice_number TEXT,
  ADD COLUMN IF NOT EXISTS xero_credit_note_number TEXT,
  ADD COLUMN IF NOT EXISTS purchase_order_number TEXT,
  ADD COLUMN IF NOT EXISTS po_to_follow BOOLEAN DEFAULT false;

COMMENT ON COLUMN complex_event_booking.xero_invoice_id IS 'Xero invoice UUID returned after invoice creation';
COMMENT ON COLUMN complex_event_booking.xero_invoice_number IS 'Xero invoice number (human-readable) for display';
COMMENT ON COLUMN complex_event_booking.xero_credit_note_number IS 'Xero credit note number if a refund/cancellation credit was issued';
COMMENT ON COLUMN complex_event_booking.purchase_order_number IS 'Purchase order number provided by the booker for account/invoice payments';
COMMENT ON COLUMN complex_event_booking.po_to_follow IS 'Whether the purchase order number will be supplied later';
