-- Add purchase order columns to booking
-- Brings single-event bookings to parity with complex_event_booking, which
-- already has these columns via migrations/add_xero_columns_to_complex_event_booking.sql.
-- The PO submission flow (api/_lib/pendingPoInvoice.js) and related reports
-- assume these columns exist on the booking table.

ALTER TABLE booking ADD COLUMN IF NOT EXISTS purchase_order_number TEXT;
ALTER TABLE booking ADD COLUMN IF NOT EXISTS po_to_follow BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN booking.purchase_order_number IS 'Purchase order number provided by the booker for account/invoice payments';
COMMENT ON COLUMN booking.po_to_follow IS 'Whether the purchase order number will be supplied later';
