-- Prerequisites: 20260420_add_scheduled_email_session_id,
-- 20260508_add_event_email_custom_datetime, 202612310039_training_reminder_target_snapshot.
-- Apply only to verified DEST with owner approval. No queue writes or grants.
BEGIN;
ALTER TABLE public.event_email
  ADD COLUMN IF NOT EXISTS follow_up_scope text,
  ADD COLUMN IF NOT EXISTS follow_up_delay numeric,
  ADD COLUMN IF NOT EXISTS follow_up_unit text;
ALTER TABLE public.event_email DROP CONSTRAINT IF EXISTS event_email_email_type_check;
ALTER TABLE public.event_email ADD CONSTRAINT event_email_email_type_check
  CHECK (email_type IN ('confirmation', 'booking_confirmation', 'reminder', 'follow_up'));
ALTER TABLE public.event_email ADD CONSTRAINT event_email_follow_up_config_check CHECK (
  email_type <> 'follow_up' OR (
    follow_up_scope IS NOT NULL AND follow_up_scope IN ('event', 'day', 'session')
    AND follow_up_delay IS NOT NULL AND follow_up_delay >= 0 AND follow_up_delay < 'Infinity'::numeric
    AND follow_up_unit IS NOT NULL AND follow_up_unit IN ('minutes', 'hours', 'days')
  )
);
ALTER TABLE public.scheduled_email
  ADD COLUMN IF NOT EXISTS follow_up_target_key text,
  ADD COLUMN IF NOT EXISTS follow_up_target_snapshot text,
  ADD COLUMN IF NOT EXISTS follow_up_booking_table text;
ALTER TABLE public.scheduled_email ADD CONSTRAINT scheduled_email_follow_up_identity_check CHECK (
  follow_up_target_key IS NULL OR (
    follow_up_target_snapshot IS NOT NULL AND follow_up_booking_table IS NOT NULL
    AND follow_up_booking_table IN ('booking', 'complex_event_booking')
    AND (follow_up_target_key = 'event'
      OR follow_up_target_key ~ '^day:[0-9]{4}-[0-9]{2}-[0-9]{2}$'
      OR follow_up_target_key ~ '^session:[0-9a-fA-F-]{36}$')
  )
);
-- Preserve all legacy reminder identities and delivery history.
DROP INDEX public.idx_scheduled_email_unique;
CREATE UNIQUE INDEX idx_scheduled_email_unique ON public.scheduled_email
  (event_email_id, booking_id, COALESCE(session_id, '00000000-0000-0000-0000-000000000000'))
  WHERE follow_up_target_key IS NULL;
CREATE UNIQUE INDEX idx_scheduled_email_follow_up_unique ON public.scheduled_email
  (event_email_id, booking_id, follow_up_target_key)
  WHERE follow_up_target_key IS NOT NULL;
COMMIT;
