-- Task #1519: Per-event audience choice for member-group events.
-- A group event is private to its member_group by default. When
-- group_event_public = true the Group Admin has chosen to make it visible to
-- everyone (members and logged-out visitors), like a normal public event.
-- Applies to both simple (event) and complex (complex_event) events.
-- Idempotent; safe to re-run.

ALTER TABLE event
  ADD COLUMN IF NOT EXISTS group_event_public BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE complex_event
  ADD COLUMN IF NOT EXISTS group_event_public BOOLEAN NOT NULL DEFAULT false;
