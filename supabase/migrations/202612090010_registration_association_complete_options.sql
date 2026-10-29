BEGIN;
-- Return every eligible name/ID. Tenant, event and custom-field predicates stay
-- unchanged; the UI may search, but must not require search to reveal entries.
DO $$
DECLARE definition text;
BEGIN
 SELECT pg_get_functiondef('public.event_registration_association_options(uuid,uuid,boolean,text,text,uuid)'::regprocedure)
 INTO definition;
 IF strpos(definition,'LIMIT 51')=0 OR strpos(definition,'LIMIT 50')=0
    OR strpos(definition,'jsonb_array_length(result)>50')=0 THEN
   RAISE EXCEPTION 'Unexpected association lookup limits; review before changing';
 END IF;
 definition:=replace(definition,'LIMIT 51','');
 definition:=replace(definition,'LIMIT 50','');
 definition:=replace(definition,'jsonb_array_length(result)>50','false');
 EXECUTE definition;
END $$;
REVOKE ALL ON FUNCTION public.event_registration_association_options(uuid,uuid,boolean,text,text,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.event_registration_association_options(uuid,uuid,boolean,text,text,uuid) TO service_role;
NOTIFY pgrst,'reload schema';
COMMIT;
