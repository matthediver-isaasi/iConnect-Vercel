-- Add is_online flag to complex_event (mirrors complex_event_session.is_online).
-- Read by api/_lib/eventConfirmationEmail.js when looking up a complex event
-- for a booking confirmation email.

ALTER TABLE complex_event
  ADD COLUMN IF NOT EXISTS is_online BOOLEAN NOT NULL DEFAULT false;
