BEGIN;
SET LOCAL lock_timeout='5s';
ALTER TABLE public.sales_settings ADD COLUMN IF NOT EXISTS default_product_tax_code jsonb;
CREATE OR REPLACE FUNCTION public.save_sales_accounting_configuration_with_default(
 p_tenant_id uuid,p_provider text,p_mappings jsonb,p_quickbooks_sales_item_id text,p_default_tax_code jsonb
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 IF auth.role() IS DISTINCT FROM 'service_role' THEN
  RAISE EXCEPTION 'service role required' USING ERRCODE='42501';
 END IF;
 IF p_default_tax_code IS NOT NULL AND (
   jsonb_typeof(p_default_tax_code) IS DISTINCT FROM 'object'
   OR p_default_tax_code->>'provider' IS DISTINCT FROM p_provider
   OR nullif(p_default_tax_code->>'id','') IS NULL
   OR nullif(p_default_tax_code->>'name','') IS NULL
   OR jsonb_typeof(p_default_tax_code->'rateBps') IS DISTINCT FROM 'number'
 ) THEN RAISE EXCEPTION 'invalid default VAT code' USING ERRCODE='22023'; END IF;
 PERFORM public.save_sales_accounting_configuration(p_tenant_id,p_provider,p_mappings,p_quickbooks_sales_item_id);
 INSERT INTO public.sales_settings(tenant_id,default_product_tax_code)
 VALUES(p_tenant_id,p_default_tax_code)
 ON CONFLICT(tenant_id) DO UPDATE SET default_product_tax_code=EXCLUDED.default_product_tax_code,
  version=sales_settings.version+1,updated_at=now();
END $$;
REVOKE ALL ON FUNCTION public.save_sales_accounting_configuration_with_default(uuid,text,jsonb,text,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.save_sales_accounting_configuration_with_default(uuid,text,jsonb,text,jsonb) TO service_role;
NOTIFY pgrst,'reload schema';
COMMIT;
