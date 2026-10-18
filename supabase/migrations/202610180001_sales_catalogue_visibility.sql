BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

ALTER TABLE public.sales_settings
 ADD COLUMN IF NOT EXISTS show_internal_code boolean NOT NULL DEFAULT true,
 ADD COLUMN IF NOT EXISTS show_sku boolean NOT NULL DEFAULT true;

-- Extend the installed RPC rather than replacing its unrelated fields. This
-- allows independent settings additions to survive either merge/apply order.
-- Unknown RPC structure fails closed; never silently install an older version.
DO $migration$
DECLARE
 definition text;
 validation_anchor text := 'INSERT INTO public.sales_settings(tenant_id)';
 update_anchor text := 'UPDATE public.sales_settings SET';
BEGIN
 SELECT pg_get_functiondef('public.patch_sales_settings(uuid,integer,jsonb,text,text)'::regprocedure)
 INTO definition;
 IF position('catalogue_visibility_v1' IN definition) = 0 THEN
  IF position(validation_anchor IN definition) = 0
    OR position(update_anchor IN definition) = 0
    OR position('FOR UPDATE' IN definition) = 0
    OR position('40001' IN definition) = 0
    OR position('ON CONFLICT' IN definition) = 0
    OR position('sales_audit_event' IN definition) = 0 THEN
   RAISE EXCEPTION 'Review the installed patch_sales_settings definition before extending visibility';
  END IF;
  definition := replace(definition, validation_anchor, $validation$
 -- catalogue_visibility_v1: strict JSON booleans, including explicit false.
 IF (p_patch ? 'showInternalCode' AND jsonb_typeof(p_patch->'showInternalCode') IS DISTINCT FROM 'boolean')
  OR (p_patch ? 'showSku' AND jsonb_typeof(p_patch->'showSku') IS DISTINCT FROM 'boolean') THEN
  RAISE EXCEPTION 'Catalogue visibility settings must be booleans' USING ERRCODE='22023';
 END IF;
 INSERT INTO public.sales_settings(tenant_id)$validation$);
  definition := replace(definition, update_anchor, $update$
 UPDATE public.sales_settings SET
  show_internal_code=CASE WHEN p_patch ? 'showInternalCode' THEN (p_patch->>'showInternalCode')::boolean ELSE show_internal_code END,
  show_sku=CASE WHEN p_patch ? 'showSku' THEN (p_patch->>'showSku')::boolean ELSE show_sku END,$update$);
  EXECUTE definition;
 END IF;
END $migration$;

REVOKE ALL ON FUNCTION public.patch_sales_settings(uuid,integer,jsonb,text,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.patch_sales_settings(uuid,integer,jsonb,text,text) TO service_role;
NOTIFY pgrst, 'reload schema';
COMMIT;
