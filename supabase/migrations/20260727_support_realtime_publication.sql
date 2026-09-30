-- Add support ticket tables to the supabase_realtime publication so the
-- conversational ticket UI receives live INSERT/UPDATE events.
-- Idempotent: safe to run repeatedly.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'support_ticket_response'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.support_ticket_response;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'support_ticket'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.support_ticket;
  END IF;
END $$;
