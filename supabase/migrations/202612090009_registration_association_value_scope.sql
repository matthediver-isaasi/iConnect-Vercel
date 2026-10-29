BEGIN;
-- Organisation values inherit tenant ownership from their organisation and
-- validated field. Group values additionally have their own tenant_id.
DO $$
DECLARE definition text;
BEGIN
 SELECT pg_get_functiondef('public.event_registration_association_options(uuid,uuid,boolean,text,text,uuid)'::regprocedure)
 INTO definition;
 IF strpos(definition,'WHERE v.tenant_id=$1')=0 OR
    strpos(definition,$needle$r',tbl,val_tbl,owner_col)$needle$)=0 THEN
   RAISE EXCEPTION 'Unexpected association lookup definition; review before repair';
 END IF;
 definition:=replace(definition,'WHERE v.tenant_id=$1','WHERE %s');
 definition:=replace(definition,$needle$r',tbl,val_tbl,owner_col)$needle$,
   $replacement$r',tbl,val_tbl,CASE WHEN k='group' THEN 'v.tenant_id=$1' ELSE 'true' END,owner_col)$replacement$);
 EXECUTE definition;
END $$;
REVOKE ALL ON FUNCTION public.event_registration_association_options(uuid,uuid,boolean,text,text,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.event_registration_association_options(uuid,uuid,boolean,text,text,uuid) TO service_role;
NOTIFY pgrst,'reload schema';
COMMIT;
