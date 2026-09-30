-- Add created_date to support_ticket_response so the conversation UI can
-- sort responses chronologically (base44 list sort uses created_date).
-- Idempotent: safe to run repeatedly.
ALTER TABLE public.support_ticket_response
  ADD COLUMN IF NOT EXISTS created_date TIMESTAMPTZ NOT NULL DEFAULT now();
