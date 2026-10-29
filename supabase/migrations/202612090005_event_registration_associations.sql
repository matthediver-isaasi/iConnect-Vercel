BEGIN;
ALTER TABLE public.event ADD COLUMN registration_association_config jsonb;
ALTER TABLE public.complex_event ADD COLUMN registration_association_config jsonb;
-- Legacy event-table grants must not authorise browser-controlled signup roles.
-- Do not alter the existing event RLS/grants as part of this feature.
CREATE FUNCTION public.guard_registration_association_config()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
BEGIN
 IF current_user NOT IN ('postgres','service_role','supabase_admin')
   AND NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname=current_user AND rolsuper) THEN
   IF TG_OP='INSERT' THEN
     IF NEW.registration_association_config IS NOT NULL THEN
       RAISE EXCEPTION 'Registration account settings require server authorization' USING ERRCODE='42501';
     END IF;
   ELSIF NEW.registration_association_config IS DISTINCT FROM OLD.registration_association_config THEN
     RAISE EXCEPTION 'Registration account settings require server authorization' USING ERRCODE='42501';
   END IF;
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.guard_registration_association_config() FROM PUBLIC,anon,authenticated;
CREATE TRIGGER event_registration_association_config_guard
 BEFORE INSERT OR UPDATE OF registration_association_config ON public.event
 FOR EACH ROW EXECUTE FUNCTION public.guard_registration_association_config();
CREATE TRIGGER complex_registration_association_config_guard
 BEFORE INSERT OR UPDATE OF registration_association_config ON public.complex_event
 FOR EACH ROW EXECUTE FUNCTION public.guard_registration_association_config();
CREATE FUNCTION public.registration_association_value_matches(p_stored text,p_value text)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$
DECLARE parsed jsonb;
BEGIN
 IF p_stored=p_value THEN RETURN true; END IF;
 BEGIN parsed:=p_stored::jsonb; EXCEPTION WHEN invalid_text_representation THEN RETURN false; END;
 IF jsonb_typeof(parsed)='array' THEN
   RETURN EXISTS(SELECT 1 FROM jsonb_array_elements_text(parsed) v WHERE v=p_value);
 END IF;
 RETURN false;
END $$;
REVOKE ALL ON FUNCTION public.registration_association_value_matches(text,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.registration_association_value_matches(text,text) TO service_role;

-- Only the server may discover the filtered list. Public responses contain
-- display names and IDs, never custom field values or the filtering policy.
CREATE FUNCTION public.event_registration_association_options(
 p_tenant uuid,p_event uuid,p_complex boolean,p_query text DEFAULT '',
 p_kind text DEFAULT NULL,p_id uuid DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE e jsonb; c jsonb; options jsonb; setting jsonb; k text; tbl text; val_tbl text; owner_col text; found jsonb; result jsonb:='[]';
BEGIN
 IF p_tenant IS NULL OR p_event IS NULL OR p_complex IS NULL THEN RAISE EXCEPTION 'Invalid event'; END IF;
 EXECUTE format('SELECT to_jsonb(e) FROM public.%I e WHERE id=$1 AND tenant_id=$2',CASE WHEN p_complex THEN 'complex_event' ELSE 'event' END)
 INTO e USING p_event,p_tenant;
 IF e IS NULL OR coalesce(e->>'status','') NOT IN ('published','tbc','draft','immediate') THEN RAISE EXCEPTION 'Event not available'; END IF;
 c:=e->'registration_association_config';
 IF c IS NULL OR (c#>>'{organizations,enabled}' IS DISTINCT FROM 'true' AND c#>>'{groups,enabled}' IS DISTINCT FROM 'true')
 THEN RETURN jsonb_build_object('enabled',false,'options','[]'::jsonb,'hasMore',false); END IF;
 FOR k IN SELECT unnest(ARRAY['organization','group']) LOOP
   IF p_kind IS NOT NULL AND p_kind<>k THEN CONTINUE; END IF;
   setting:=c->CASE WHEN k='organization' THEN 'organizations' ELSE 'groups' END;
   IF setting->>'enabled' IS DISTINCT FROM 'true' THEN CONTINUE; END IF;
   tbl:=CASE WHEN k='organization' THEN 'organization' ELSE 'organization_group' END;
   val_tbl:=tbl||'_preference_value';owner_col:=tbl||'_id';
   IF nullif(setting->>'field_id','') IS NOT NULL AND NOT EXISTS(
     SELECT 1 FROM preference_field WHERE id=(setting->>'field_id')::uuid AND tenant_id=p_tenant AND entity_scope=tbl
   ) THEN RAISE EXCEPTION 'Filter field unavailable'; END IF;
   EXECUTE format('SELECT coalesce(jsonb_agg(r),''[]'') FROM (
     SELECT $6::text AS kind,o.id,o.name FROM public.%I o
     WHERE o.tenant_id=$1 AND ($2::uuid IS NULL OR o.id=$2)
     AND (coalesce($3,'''')='''' OR position(lower($3) in lower(o.name))>0)
     AND ($4::uuid IS NULL OR EXISTS(SELECT 1 FROM public.%I v WHERE v.tenant_id=$1
       AND v.%I=o.id AND v.field_id=$4 AND public.registration_association_value_matches(v.value,$5)))
     ORDER BY lower(o.name),o.id LIMIT 51) r',tbl,val_tbl,owner_col)
   INTO found USING p_tenant,p_id,left(p_query,150),nullif(setting->>'field_id','')::uuid,setting->>'value',k;
   result:=result||found;
 END LOOP;
 SELECT coalesce(jsonb_agg(x),'[]') INTO options FROM (
   SELECT value AS x FROM jsonb_array_elements(result) ORDER BY lower(value->>'name'),value->>'kind',value->>'id' LIMIT 50
 ) limited;
 RETURN jsonb_build_object('enabled',true,'options',options,'hasMore',jsonb_array_length(result)>50);
END $$;
REVOKE ALL ON FUNCTION public.event_registration_association_options(uuid,uuid,boolean,text,text,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.event_registration_association_options(uuid,uuid,boolean,text,text,uuid) TO service_role;
NOTIFY pgrst,'reload schema';
COMMIT;
