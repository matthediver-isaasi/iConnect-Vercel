-- Backfill complex_event_booking rows that were incorrectly created with
-- status='pending' purely because of account/invoice payment methods.
-- These bookings are fully confirmed; only the payment is outstanding (tracked
-- in payment_status). This aligns them with the standard event flow which
-- always inserts status='confirmed' for account/invoice bookings.
UPDATE complex_event_booking
SET status = 'confirmed'
WHERE status = 'pending'
  AND payment_method IN ('account', 'invoice');
