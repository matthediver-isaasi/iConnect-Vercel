-- Task #1253: Event-linked forms.
--
-- A form can optionally be marked as "related to an event" and pointed at a
-- single (future) event. Every submission to that form then carries a
-- reference back to the chosen event so admins can review submissions
-- per event/attendee.
--
--   form.is_event_related : on/off flag for the builder toggle. Lets the
--                           "related to an event" state round-trip even before
--                           an event has been picked.
--   form.related_event_id : the single linked event (nullable).
--   form_submission.event_id : the event a given submission relates to,
--                              copied from the form's related_event_id at
--                              submission time (nullable).
--
-- All columns are nullable / default off, so forms not linked to an event
-- behave exactly as before. Safe to re-run on any environment.

BEGIN;

ALTER TABLE form
  ADD COLUMN IF NOT EXISTS is_event_related boolean NOT NULL DEFAULT false;

ALTER TABLE form
  ADD COLUMN IF NOT EXISTS related_event_id uuid;

ALTER TABLE form_submission
  ADD COLUMN IF NOT EXISTS event_id uuid;

COMMIT;

NOTIFY pgrst, 'reload schema';
