BEGIN;
-- Eligibility applies equally to discovery, search and exact-ID validation.
DO $$
DECLARE definition text;
BEGIN
 SELECT pg_get_functiondef('public.event_registration_association_options(uuid,uuid,boolean,text,text,uuid)'::regprocedure)
 INTO definition;
 IF strpos(definition,'WHERE o.tenant_id=$1 AND ($2::uuid IS NULL OR o.id=$2)')=0 THEN
   RAISE EXCEPTION 'Unexpected association lookup definition; review before changing';
 END IF;
 -- Quotes are doubled because the predicate lives inside dynamic SQL.
 definition:=replace(definition,
   $needle$WHERE o.tenant_id=$1 AND ($2::uuid IS NULL OR o.id=$2)$needle$,
   $replacement$WHERE o.tenant_id=$1 AND position(''zombie'' in lower(coalesce(o.name,'''')))=0 AND ($2::uuid IS NULL OR o.id=$2)$replacement$);
 EXECUTE definition;
END $$;
REVOKE ALL ON FUNCTION public.event_registration_association_options(uuid,uuid,boolean,text,text,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.event_registration_association_options(uuid,uuid,boolean,text,text,uuid) TO service_role;
NOTIFY pgrst,'reload schema';
COMMIT;
