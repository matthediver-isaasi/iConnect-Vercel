-- Independent of legacy role/group audience; existing tickets remain unrestricted.
ALTER TABLE public.complex_event_ticket_class
  ADD COLUMN IF NOT EXISTS organization_type_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS organization_type_field_id uuid,
  ADD COLUMN IF NOT EXISTS organization_type_values jsonb NOT NULL DEFAULT '[]'::jsonb;

CREATE OR REPLACE FUNCTION public.validate_ticket_organization_type(ticket jsonb, tenant uuid)
RETURNS void LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE
  options jsonb;
  selected jsonb;
  option jsonb;
  allowed text[] := ARRAY[]::text[];
  option_value jsonb;
BEGIN
  IF ticket->'organization_type_enabled' IS NULL OR ticket->'organization_type_enabled' IN ('null'::jsonb,'false'::jsonb) THEN RETURN; END IF;
  IF ticket->'organization_type_enabled' <> 'true'::jsonb
    OR ticket->>'audience_mode' = 'selected_members'
    OR coalesce(ticket->>'organization_type_field_id','') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    OR jsonb_typeof(ticket->'organization_type_values') IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'Invalid Organisation Type ticket policy' USING ERRCODE='23514';
  END IF;
  IF jsonb_array_length(ticket->'organization_type_values') = 0 THEN
    RAISE EXCEPTION 'Select at least one Organisation Type' USING ERRCODE='23514';
  END IF;
  SELECT to_jsonb(f)->'options' INTO options FROM public.preference_field f
    WHERE f.id=(ticket->>'organization_type_field_id')::uuid AND f.tenant_id=tenant
      AND f.entity_scope='organization' AND f.is_active=true
      AND f.name IN ('org_type','organisation_type','organization_type') FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Organisation Type field is missing, inactive or belongs to another tenant' USING ERRCODE='23514';
  END IF;
  IF jsonb_typeof(options)='string' THEN options := (options #>> '{}')::jsonb; END IF;
  IF jsonb_typeof(options) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'Organisation Type options are malformed' USING ERRCODE='23514';
  END IF;
  FOR option IN SELECT value FROM jsonb_array_elements(options) LOOP
    option_value := CASE WHEN jsonb_typeof(option)='object' THEN option->'value' ELSE option END;
    IF jsonb_typeof(option_value) NOT IN ('string','number','boolean')
      OR option_value IS NULL OR btrim(option_value #>> '{}')='' THEN
      RAISE EXCEPTION 'Organisation Type options are malformed' USING ERRCODE='23514';
    END IF;
    allowed := array_append(allowed, option_value #>> '{}');
  END LOOP;
  FOR selected IN SELECT value FROM jsonb_array_elements(ticket->'organization_type_values') LOOP
    IF jsonb_typeof(selected)<>'string' OR NOT (selected #>> '{}')=ANY(allowed) THEN
      RAISE EXCEPTION 'Remove unavailable Organisation Type selections before saving' USING ERRCODE='23514';
    END IF;
  END LOOP;
END $$;
REVOKE ALL ON FUNCTION public.validate_ticket_organization_type(jsonb,uuid) FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.enforce_ticket_organization_type()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE config jsonb; ticket jsonb;
BEGIN
  IF TG_TABLE_NAME='complex_event_ticket_class' THEN
    PERFORM public.validate_ticket_organization_type(to_jsonb(NEW), NEW.tenant_id);
    RETURN NEW;
  END IF;
  IF TG_OP='UPDATE' AND NEW.pricing_config IS NOT DISTINCT FROM OLD.pricing_config
    AND NEW.tenant_id IS NOT DISTINCT FROM OLD.tenant_id THEN RETURN NEW; END IF;
  config := to_jsonb(NEW)->'pricing_config';
  IF config IS NULL OR config IN ('null'::jsonb,'""'::jsonb) THEN RETURN NEW; END IF;
  IF jsonb_typeof(config)='string' THEN config := (config #>> '{}')::jsonb; END IF;
  IF jsonb_typeof(config->'ticket_classes')='array' THEN
    FOR ticket IN SELECT value FROM jsonb_array_elements(config->'ticket_classes') LOOP
      PERFORM public.validate_ticket_organization_type(ticket, NEW.tenant_id);
    END LOOP;
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.enforce_ticket_organization_type() FROM PUBLIC;
DROP TRIGGER IF EXISTS ticket_organization_type_guard ON public.event;
CREATE TRIGGER ticket_organization_type_guard BEFORE INSERT OR UPDATE ON public.event
  FOR EACH ROW EXECUTE FUNCTION public.enforce_ticket_organization_type();
DROP TRIGGER IF EXISTS ticket_organization_type_guard ON public.complex_event_ticket_class;
CREATE TRIGGER ticket_organization_type_guard BEFORE INSERT OR UPDATE ON public.complex_event_ticket_class
  FOR EACH ROW EXECUTE FUNCTION public.enforce_ticket_organization_type();
