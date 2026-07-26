-- Task #3100: staff-only internal notes on support ticket conversations.
-- Adds an is_internal_note flag to support_ticket_response. Internal notes
-- are filtered out of every member-facing read path server-side and never
-- trigger member notifications.
-- Idempotent: safe to re-run.

ALTER TABLE public.support_ticket_response
  ADD COLUMN IF NOT EXISTS is_internal_note BOOLEAN NOT NULL DEFAULT false;
