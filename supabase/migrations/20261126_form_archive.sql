BEGIN;
ALTER TABLE public.form ADD COLUMN IF NOT EXISTS archived_at timestamptz;

CREATE OR REPLACE FUNCTION public.enforce_form_archive_inactive()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF NEW.archived_at IS NOT NULL THEN
    NEW.is_active := false;
  ELSIF TG_OP = 'UPDATE' AND OLD.archived_at IS NOT NULL THEN
    -- Restoring never republishes a form, even through generic API updates.
    NEW.is_active := false;
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS enforce_form_archive_inactive ON public.form;
CREATE TRIGGER enforce_form_archive_inactive
BEFORE INSERT OR UPDATE ON public.form
FOR EACH ROW EXECUTE FUNCTION public.enforce_form_archive_inactive();
COMMIT;