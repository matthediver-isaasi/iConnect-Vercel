-- Form width presets.
-- Existing rows remain narrow, while the check constraint keeps future writes
-- inside the same enum accepted by the Form schema and API.

ALTER TABLE public.form
  ADD COLUMN IF NOT EXISTS form_width TEXT NOT NULL DEFAULT 'narrow';

-- Be defensive if this migration is applied to a database where a partially
-- created column already exists. Read paths also normalize invalid legacy data,
-- but persistence should converge it before enforcing the constraint.
UPDATE public.form
SET form_width = 'narrow'
WHERE form_width IS NULL
   OR form_width NOT IN ('narrow', 'medium', 'wide');

ALTER TABLE public.form
  ALTER COLUMN form_width SET DEFAULT 'narrow',
  ALTER COLUMN form_width SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'public.form'::regclass
      AND conname = 'form_form_width_check'
  ) THEN
    ALTER TABLE public.form
      ADD CONSTRAINT form_form_width_check
      CHECK (form_width IN ('narrow', 'medium', 'wide'));
  END IF;
END
$$;

NOTIFY pgrst, 'reload schema';