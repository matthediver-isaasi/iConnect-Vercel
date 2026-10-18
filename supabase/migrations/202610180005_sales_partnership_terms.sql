BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='60s';
ALTER TABLE public.sales_settings ADD COLUMN IF NOT EXISTS partnership_terms_html text NOT NULL DEFAULT '';
DO $migration$
DECLARE definition text;
BEGIN
 SELECT pg_get_functiondef('public.patch_sales_settings(uuid,integer,jsonb,text,text)'::regprocedure) INTO definition;
 IF position('partnership_terms_v1' IN definition)=0 THEN
  IF position('billing_presets_v1' IN definition)=0 OR position('FOR UPDATE' IN definition)=0
   OR position('ON CONFLICT' IN definition)=0 OR position('40001' IN definition)=0
   OR position('INSERT INTO public.sales_settings(tenant_id)' IN definition)=0
   OR position('UPDATE public.sales_settings SET' IN definition)=0 THEN
   RAISE EXCEPTION 'Review latest Sales settings contract before extending partnership terms';
  END IF;
  definition := replace(definition,'INSERT INTO public.sales_settings(tenant_id)', $v$
  -- partnership_terms_v1
  IF p_patch ? 'partnershipTermsHtml' AND (
    jsonb_typeof(p_patch->'partnershipTermsHtml') IS DISTINCT FROM 'string'
    OR char_length(p_patch->>'partnershipTermsHtml')>100000
  ) THEN RAISE EXCEPTION 'Invalid partnership terms' USING ERRCODE='22023'; END IF;
  INSERT INTO public.sales_settings(tenant_id)$v$);
  definition := replace(definition,'UPDATE public.sales_settings SET', $v$
  UPDATE public.sales_settings SET
   partnership_terms_html=CASE WHEN p_patch ? 'partnershipTermsHtml' THEN p_patch->>'partnershipTermsHtml' ELSE partnership_terms_html END,$v$);
  EXECUTE definition;
 END IF;
END $migration$;
REVOKE ALL ON FUNCTION public.patch_sales_settings(uuid,integer,jsonb,text,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.patch_sales_settings(uuid,integer,jsonb,text,text) TO service_role;
COMMIT;
