-- Add member_group_ids column to complex_event_ticket_class to support
-- restricting tickets by member group in addition to roles (OR logic).
-- Single-style events store the same field inside each entry of
-- pricing_config.ticket_classes (JSONB) so no migration is needed there.
--
-- Storage type: JSONB (not text[]). This intentionally mirrors how
-- role_ids and linked_track_ids are stored on the same table so all
-- access-control id arrays are queryable/updatable through the same
-- shape. Application code (api/_lib/ticketAccess.js) normalizes
-- null/missing values to [] so legacy rows continue to work.

ALTER TABLE complex_event_ticket_class
  ADD COLUMN IF NOT EXISTS member_group_ids JSONB NOT NULL DEFAULT '[]'::jsonb;
