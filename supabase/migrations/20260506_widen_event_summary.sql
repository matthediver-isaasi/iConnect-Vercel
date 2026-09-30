-- task #695: widen event/complex_event summary columns from varchar(150) to text
-- so the configurable `event_summary_max_length` system setting actually takes
-- effect end-to-end. text is preferred (matches `description`) so the only
-- enforced limit is the application-level setting.
-- Idempotent + safe: existing data is preserved (no values were ever stored
-- longer than 150 chars), and re-running ALTER TYPE TEXT on an already-text
-- column is a no-op for Postgres in practice.
ALTER TABLE event ALTER COLUMN summary TYPE text;
ALTER TABLE complex_event ALTER COLUMN summary TYPE text;
