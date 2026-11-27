BEGIN;
-- Forward-only extension. Leave the scalar matcher unchanged for other callers.
-- An explicit values key wins over the legacy value, even when empty/invalid.
CREATE OR REPLACE FUNCTION public.registration_association_values_match(p_stored text,p_values jsonb)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$
DECLARE choices jsonb;
BEGIN
 IF p_values IS NULL OR jsonb_typeof(p_values)<>'array' THEN RETURN false; END IF;
 choices:=p_values;
 IF jsonb_array_length(choices)=0 OR EXISTS (
   SELECT 1 FROM jsonb_array_elements(choices) v
   WHERE jsonb_typeof(v) NOT IN ('string','boolean','number')
      OR btrim(v #>> '{}')='' OR length(v #>> '{}')>1000
 ) THEN RETURN false; END IF;
 RETURN EXISTS (
   SELECT 1 FROM jsonb_array_elements_text(choices) v
   WHERE public.registration_association_value_matches(p_stored,v)
 );
END $$;
REVOKE ALL ON FUNCTION public.registration_association_values_match(text,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.registration_association_values_match(text,jsonb) TO service_role;

DO $$
DECLARE definition text;
BEGIN
 SELECT pg_get_functiondef('public.event_registration_association_options(uuid,uuid,boolean,text,text,uuid)'::regprocedure)
 INTO definition;
 IF strpos(definition,'public.registration_association_value_matches(v.value,$5)')=0
    OR strpos(definition,$needle$setting->>'value',k$needle$)=0
    OR strpos(definition,'LIMIT 50')>0
    OR strpos(definition,$needle$position(''zombie''$needle$)=0 THEN
   RAISE EXCEPTION 'Unexpected association lookup definition; review before changing';
 END IF;
 definition:=replace(definition,'public.registration_association_value_matches(v.value,$5)',
   'public.registration_association_values_match(v.value,$5)');
 definition:=replace(definition,$needle$setting->>'value',k$needle$,
   $replacement$CASE WHEN setting ? 'values' THEN setting->'values'
     WHEN jsonb_typeof(setting->'value')='array' THEN setting->'value'
     ELSE jsonb_build_array(setting->'value') END,k$replacement$);
 EXECUTE definition;
END $$;
REVOKE ALL ON FUNCTION public.event_registration_association_options(uuid,uuid,boolean,text,text,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.event_registration_association_options(uuid,uuid,boolean,text,text,uuid) TO service_role;
NOTIFY pgrst,'reload schema';
COMMIT;
