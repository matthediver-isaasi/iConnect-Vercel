-- Add columns for absolute-datetime event reminder emails. The
-- api/event-emails/[eventId].js save path writes `custom_unit` and
-- `custom_send_at` when an admin selects the "specific date/time" option,
-- but those columns were never added to `event_email`, so every save was
-- silently failing and no `scheduled_email` rows were ever queued.

ALTER TABLE event_email
  ADD COLUMN IF NOT EXISTS custom_unit text,
  ADD COLUMN IF NOT EXISTS custom_send_at timestamptz;
