-- Optional per-ticket release instants; existing tickets remain immediately
-- available. Simple event tickets store the same fields in pricing_config JSON.
ALTER TABLE public.complex_event_ticket_class
  ADD COLUMN IF NOT EXISTS release_at timestamptz,
  ADD COLUMN IF NOT EXISTS release_timezone text;

COMMENT ON COLUMN public.complex_event_ticket_class.release_at IS
  'Optional absolute ticket release instant. NULL with NULL release_timezone means immediate availability; release is inclusive.';
COMMENT ON COLUMN public.complex_event_ticket_class.release_timezone IS
  'Saved IANA timezone for release display; does not follow later changes to the event timezone.';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.complex_event_ticket_class'::regclass
      AND conname = 'complex_ticket_release_pair'
  ) THEN
    ALTER TABLE public.complex_event_ticket_class
      ADD CONSTRAINT complex_ticket_release_pair CHECK (
        (release_at IS NULL AND release_timezone IS NULL)
        OR (release_at IS NOT NULL AND isfinite(release_at)
          AND release_timezone IS NOT NULL AND length(btrim(release_timezone)) > 0)
      );
  END IF;
END $$;