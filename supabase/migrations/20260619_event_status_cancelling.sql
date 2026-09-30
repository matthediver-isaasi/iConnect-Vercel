-- Allow 'cancelling' in the event/complex_event status check constraints.
-- The safe-deletion flow (api/_lib/eventDeletion.js) flips status to
-- 'cancelling' as a lock before cancelling bookings, but the live constraints
-- only permitted draft/published/tbc (+ closed for complex events), so the very
-- first step of every delete violated the constraint. Idempotent.

ALTER TABLE event DROP CONSTRAINT IF EXISTS events_status_check;
ALTER TABLE event ADD CONSTRAINT events_status_check
  CHECK (status = ANY (ARRAY[
    'draft'::text,
    'published'::text,
    'tbc'::text,
    'cancelling'::text
  ]));

ALTER TABLE complex_event DROP CONSTRAINT IF EXISTS complex_event_status_check;
ALTER TABLE complex_event ADD CONSTRAINT complex_event_status_check
  CHECK (status = ANY (ARRAY[
    'draft'::text,
    'published'::text,
    'tbc'::text,
    'closed'::text,
    'cancelling'::text
  ]));
