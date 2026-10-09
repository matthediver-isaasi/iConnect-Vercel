BEGIN;
SET LOCAL lock_timeout='5s';
ALTER TABLE public.sales_catalogue_product ADD COLUMN IF NOT EXISTS tax_code jsonb;
COMMENT ON COLUMN public.sales_catalogue_product.tax_code IS
 'Validated provider tax identity {provider,id,name,rateBps}. NULL preserves legacy percentage mapping. Quote catalogue_snapshot freezes this identity.';
CREATE OR REPLACE FUNCTION public.save_sales_accounting_configuration(
  p_tenant_id uuid,p_provider text,p_mappings jsonb,p_quickbooks_sales_item_id text
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE mapping jsonb;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'service role required' USING ERRCODE='42501'; END IF;
  IF p_tenant_id IS NULL OR p_provider IS NULL OR p_provider NOT IN ('xero','quickbooks')
     OR p_mappings IS NULL OR jsonb_typeof(p_mappings)<>'array' THEN
    RAISE EXCEPTION 'invalid accounting configuration' USING ERRCODE='22023';
  END IF;
  IF p_provider='quickbooks' AND nullif(btrim(p_quickbooks_sales_item_id),'') IS NULL THEN
    RAISE EXCEPTION 'QuickBooks sales item is required' USING ERRCODE='22023';
  END IF;
  -- Preserve all legacy mappings; new-code setup must not erase historical routing.
  FOR mapping IN SELECT value FROM jsonb_array_elements(p_mappings) LOOP
    INSERT INTO public.sales_accounting_tax_mapping(
      tenant_id,provider,tax_treatment,tax_rate_bps,provider_tax_code,provider_tax_name
    ) VALUES (p_tenant_id,p_provider,'standard',(mapping->>'taxRateBps')::integer,
      mapping->>'providerTaxCodeId',mapping->>'providerTaxCodeName')
    ON CONFLICT(tenant_id,provider,tax_treatment,tax_rate_bps)
    DO UPDATE SET provider_tax_code=EXCLUDED.provider_tax_code,provider_tax_name=EXCLUDED.provider_tax_name;
  END LOOP;
  IF p_provider='quickbooks' THEN
    INSERT INTO public.system_settings(tenant_id,setting_key,setting_value)
      VALUES(p_tenant_id,'quickbooks_sales_item_id',p_quickbooks_sales_item_id)
    ON CONFLICT(tenant_id,setting_key) DO UPDATE SET setting_value=EXCLUDED.setting_value;
  END IF;
END $$;
REVOKE ALL ON FUNCTION public.save_sales_accounting_configuration(uuid,text,jsonb,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.save_sales_accounting_configuration(uuid,text,jsonb,text) TO service_role;
NOTIFY pgrst,'reload schema';
COMMIT;
