BEGIN;

ALTER TABLE public.event
  ADD COLUMN IF NOT EXISTS speaker_display_mode text NOT NULL DEFAULT 'expanded',
  ADD COLUMN IF NOT EXISTS sponsor_display_mode text NOT NULL DEFAULT 'expanded';

ALTER TABLE public.complex_event
  ADD COLUMN IF NOT EXISTS speaker_display_mode text NOT NULL DEFAULT 'expanded',
  ADD COLUMN IF NOT EXISTS sponsor_display_mode text NOT NULL DEFAULT 'expanded';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.event'::regclass
      AND conname = 'event_speaker_display_mode_check'
  ) THEN
    ALTER TABLE public.event
      ADD CONSTRAINT event_speaker_display_mode_check
      CHECK (speaker_display_mode IN ('hidden', 'collapsed', 'expanded'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.event'::regclass
      AND conname = 'event_sponsor_display_mode_check'
  ) THEN
    ALTER TABLE public.event
      ADD CONSTRAINT event_sponsor_display_mode_check
      CHECK (sponsor_display_mode IN ('hidden', 'collapsed', 'expanded'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.complex_event'::regclass
      AND conname = 'complex_event_speaker_display_mode_check'
  ) THEN
    ALTER TABLE public.complex_event
      ADD CONSTRAINT complex_event_speaker_display_mode_check
      CHECK (speaker_display_mode IN ('hidden', 'collapsed', 'expanded'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.complex_event'::regclass
      AND conname = 'complex_event_sponsor_display_mode_check'
  ) THEN
    ALTER TABLE public.complex_event
      ADD CONSTRAINT complex_event_sponsor_display_mode_check
      CHECK (sponsor_display_mode IN ('hidden', 'collapsed', 'expanded'));
  END IF;
END
$$;

COMMIT;