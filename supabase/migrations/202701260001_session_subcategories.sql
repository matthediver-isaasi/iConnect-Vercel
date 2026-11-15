BEGIN;
-- Parent category IDs remain historical evidence; never guess child assignments.
ALTER TABLE public.complex_event_session
  ADD COLUMN subcategory_keys text[] NOT NULL DEFAULT '{}';

CREATE FUNCTION public.validate_session_subcategory_keys()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  selection text;
  retained boolean;
BEGIN
  IF NEW.subcategory_keys IS NULL OR array_position(NEW.subcategory_keys, NULL) IS NOT NULL THEN
    RAISE EXCEPTION 'subcategory_keys must be a text array' USING ERRCODE = '23514';
  END IF;
  NEW.subcategory_keys := ARRAY(SELECT DISTINCT k FROM unnest(NEW.subcategory_keys) k ORDER BY k);
  FOREACH selection IN ARRAY NEW.subcategory_keys LOOP
    IF selection !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:.+' OR btrim(substr(selection,38)) = '' THEN
      RAISE EXCEPTION 'Invalid session subcategory key' USING ERRCODE = '23514';
    END IF;
    retained := false;
    IF TG_OP = 'UPDATE' THEN
      retained := NEW.tenant_id IS NOT DISTINCT FROM OLD.tenant_id
        AND selection = ANY(OLD.subcategory_keys);
    END IF;
    IF NOT retained THEN
      PERFORM 1 FROM public.resource_category c
        WHERE c.id = left(selection,36)::uuid AND c.tenant_id = NEW.tenant_id
          AND c.is_active IS DISTINCT FROM false
          AND to_jsonb(c.subcategories) @> jsonb_build_array(substr(selection,38))
        FOR SHARE;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'Invalid session subcategory assignment' USING ERRCODE = '23514';
      END IF;
    END IF;
  END LOOP;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.validate_session_subcategory_keys() FROM PUBLIC, anon, authenticated;
CREATE TRIGGER validate_session_subcategory_keys
  BEFORE INSERT OR UPDATE OF subcategory_keys, tenant_id ON public.complex_event_session
  FOR EACH ROW EXECUTE FUNCTION public.validate_session_subcategory_keys();
NOTIFY pgrst, 'reload schema';
COMMIT;
