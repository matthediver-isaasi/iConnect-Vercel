-- Add 'immediate' to the simple-event status check constraint. Only the event
-- table is updated; complex_event keeps its existing constraint unchanged.
-- Idempotent: DROP CONSTRAINT IF EXISTS before re-adding.

ALTER TABLE event DROP CONSTRAINT IF EXISTS events_status_check;
ALTER TABLE event ADD CONSTRAINT events_status_check
  CHECK (status = ANY (ARRAY[
    'draft'::text,
    'published'::text,
    'tbc'::text,
    'cancelling'::text,
    'immediate'::text
  ]));

ALTER TABLE event DROP CONSTRAINT IF EXISTS event_immediate_eligibility_check;
ALTER TABLE event ADD CONSTRAINT event_immediate_eligibility_check
  CHECK (
    status <> 'immediate'::text
    OR (
      is_training IS NOT TRUE
      AND member_group_id IS NULL
      AND start_date IS NULL
      AND end_date IS NULL
      AND timezone IS NULL
      AND registration_closes_at IS NULL
      AND zoom_webinar_id IS NULL
      AND zoom_meeting_id IS NULL
    )
  );

-- complex_event intentionally remains: draft, published, tbc, closed,
-- cancelling.