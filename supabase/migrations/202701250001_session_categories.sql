BEGIN;
ALTER TABLE public.complex_event_session
  ADD COLUMN IF NOT EXISTS category_ids uuid[] NOT NULL DEFAULT '{}';

CREATE OR REPLACE FUNCTION public.validate_session_category_ids()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  category_id uuid;
  retained boolean;
BEGIN
  IF NEW.category_ids IS NULL OR array_position(NEW.category_ids, NULL) IS NOT NULL THEN
    RAISE EXCEPTION 'category_ids must be a UUID array' USING ERRCODE = '23514';
  END IF;
  NEW.category_ids := ARRAY(SELECT DISTINCT id FROM unnest(NEW.category_ids) id ORDER BY id);
  FOREACH category_id IN ARRAY NEW.category_ids LOOP
    retained := false;
    IF TG_OP = 'UPDATE' THEN
      retained := NEW.tenant_id IS NOT DISTINCT FROM OLD.tenant_id
        AND category_id = ANY(OLD.category_ids);
    END IF;
    IF NOT retained THEN
      PERFORM 1 FROM public.resource_category c
        WHERE c.id = category_id AND c.tenant_id = NEW.tenant_id
          AND c.is_active IS DISTINCT FROM false FOR SHARE;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'Invalid session category assignment' USING ERRCODE = '23514';
      END IF;
    END IF;
  END LOOP;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.validate_session_category_ids() FROM PUBLIC;
DROP TRIGGER IF EXISTS validate_session_category_ids ON public.complex_event_session;
CREATE TRIGGER validate_session_category_ids
  BEFORE INSERT OR UPDATE OF category_ids, tenant_id ON public.complex_event_session
  FOR EACH ROW EXECUTE FUNCTION public.validate_session_category_ids();
NOTIFY pgrst, 'reload schema';
COMMIT;
