BEGIN;
-- Some deployed pipelines predate the optional audit note. Later commercial
-- acceptance functions already write this field; do not rewrite old history.
ALTER TABLE public.opportunity_stage_history
  ADD COLUMN IF NOT EXISTS note text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_attribute
    WHERE attrelid = 'public.opportunity_stage_history'::regclass
      AND attname = 'note' AND NOT attisdropped
      AND atttypid = 'text'::regtype AND NOT attnotnull
  ) THEN
    RAISE EXCEPTION 'opportunity stage history note must be nullable text';
  END IF;
END $$;
NOTIFY pgrst, 'reload schema';
COMMIT;
