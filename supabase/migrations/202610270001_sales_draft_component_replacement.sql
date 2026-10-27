-- Delete draft children while their parents still exist. Never weaken the
-- fail-closed immutable snapshot guards or replace the exhibition wrapper.
BEGIN;
SET LOCAL lock_timeout='5s';
DO $migration$
DECLARE definition text;
 anchor text := 'DELETE FROM public.sales_quote_line WHERE tenant_id=p_tenant_id AND quote_version_id=v.id;';
 replacement text := 'DELETE FROM public.sales_quote_bundle_component c
     USING public.sales_quote_line l
     WHERE c.tenant_id=p_tenant_id AND l.tenant_id=p_tenant_id
       AND c.quote_line_id=l.id AND l.quote_version_id=v.id;
   DELETE FROM public.sales_quote_line WHERE tenant_id=p_tenant_id AND quote_version_id=v.id;';
BEGIN
 SELECT pg_get_functiondef('public.save_sales_quote_draft_before_exhibition(uuid,uuid,integer,jsonb,text,text)'::regprocedure) INTO definition;
 IF position(replacement IN definition)>0 THEN RETURN; END IF;
 IF (length(definition)-length(replace(definition,anchor,'')))/length(anchor) <> 1
    OR position('FOR UPDATE' IN definition)=0
    OR position('quote version conflict' IN definition)=0
    OR position('only a draft can be edited' IN definition)=0
    OR position('billing_schedule=NULLIF(p_payload' IN definition)=0 THEN
   RAISE EXCEPTION 'Unknown underlying draft save implementation';
 END IF;
 EXECUTE replace(definition,anchor,replacement);
END $migration$;
-- CREATE OR REPLACE retains the existing restricted ACL and function identity.
NOTIFY pgrst,'reload schema';
COMMIT;
