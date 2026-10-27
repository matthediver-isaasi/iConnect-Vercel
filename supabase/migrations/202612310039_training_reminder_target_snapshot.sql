-- Apply to the verified DEST database before deploying training reminder code.
-- No reminders are queued, reset or sent by this migration.
ALTER TABLE public.scheduled_email
  ADD COLUMN IF NOT EXISTS training_target_snapshot text;
COMMENT ON COLUMN public.scheduled_email.training_target_snapshot IS
  'Hash of the explicitly scheduled training agenda target and timing. NULL legacy targets must be explicitly re-queued before delivery.';
