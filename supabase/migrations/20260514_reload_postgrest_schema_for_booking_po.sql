-- Force PostgREST to reload its schema cache after the booking PO columns
-- were added in 20260514_add_booking_po_columns.sql.
--
-- Symptom this fixes: PO submissions at /submit-po/<token> fail with
--   "Could not find the 'purchase_order_number' column of 'booking' in the
--    schema cache" (PGRST204)
-- even though the columns exist in Postgres, because PostgREST (the engine
-- behind Supabase's REST API) caches the schema and only refreshes on a
-- NOTIFY or a process restart. Re-running this migration is harmless.

NOTIFY pgrst, 'reload schema';
