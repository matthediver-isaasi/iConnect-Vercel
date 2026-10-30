BEGIN;

-- The assignment remains the authority for the prior expiry and renewal window.
-- Only a saved authenticated form mapping may choose a different successor.
CREATE FUNCTION public.form_expiry_only_mapped_schedule_allowed(tenant uuid, quote jsonb)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.form f
    CROSS JOIN LATERAL jsonb_array_elements(f.fields::jsonb) payment
    CROSS JOIN LATERAL jsonb_array_elements(f.fields::jsonb) source
    JOIN public.membership_tier_config c
      ON c.tenant_id=tenant AND c.id::text=quote#>>'{simulation,config,id}'
    WHERE f.tenant_id=tenant
      AND f.id::text=quote#>>'{simulation,formRenewal,selection,formId}'
      AND f.is_active IS TRUE AND f.require_authentication IS TRUE
      AND (f.deactivate_at IS NULL OR f.deactivate_at > now())
      AND payment->>'type'='membership_payment'
      AND payment->>'id'=quote#>>'{simulation,formRenewal,selection,paymentFieldId}'
      AND source->>'id'=payment#>>'{membership_schedule_mapping,source_field_id}'
      AND source->>'type' IN ('radio','select','dropdown')
      AND c.id::text=quote#>>'{simulation,formRenewal,selection,configId}'
      AND c.structure_scope_type='member' AND c.billing_period='annual'
      AND c.start_mode='immediate' AND c.is_active IS TRUE
      AND quote#>>'{simulation,formRenewal,successorStart}' IS NOT NULL
      AND (c.effective_from IS NULL
        OR c.effective_from::text <= quote#>>'{simulation,formRenewal,successorStart}')
      AND (c.effective_to IS NULL
        OR c.effective_to::text >= quote#>>'{simulation,formRenewal,successorStart}')
      AND EXISTS (
        SELECT 1 FROM jsonb_array_elements(source->'options') choice
        WHERE (CASE WHEN jsonb_typeof(choice)='string' THEN choice#>>'{}'
          ELSE coalesce(choice->>'value',choice->>'label') END)
          =quote#>>'{simulation,formRenewal,selection,sourceValue}')
      AND (SELECT count(*) FROM jsonb_array_elements(payment#>'{membership_schedule_mapping,entries}') entry
        WHERE entry->>'value'=quote#>>'{simulation,formRenewal,selection,sourceValue}')=1
      AND EXISTS (
        SELECT 1 FROM jsonb_array_elements(payment#>'{membership_schedule_mapping,entries}') entry
        WHERE entry->>'value'=quote#>>'{simulation,formRenewal,selection,sourceValue}'
          AND entry->>'config_id'=c.id::text)
  );
$$;
REVOKE ALL ON FUNCTION public.form_expiry_only_mapped_schedule_allowed(uuid,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.form_expiry_only_mapped_schedule_allowed(uuid,jsonb) TO service_role;

DO $migration$
DECLARE definition text;
  old_check text := 'OR p_quote#>>''{simulation,config,id}'' IS DISTINCT FROM policy->>''assigned_config_id''';
BEGIN
  SELECT pg_get_functiondef('public.reserve_membership_successor(uuid,uuid,uuid,uuid,date,date,text,text,jsonb)'::regprocedure)
    INTO definition;
  IF position(old_check IN definition)=0
    OR position('public.form_expiry_only_renewal_policy(prior,p_tenant_id,p_member_id)' IN definition)=0
    THEN RAISE EXCEPTION 'Unexpected expiry-only reservation contract'; END IF;
  definition := replace(definition,old_check,
    'OR (p_quote#>>''{simulation,config,id}'' IS DISTINCT FROM policy->>''assigned_config_id''
      AND NOT public.form_expiry_only_mapped_schedule_allowed(p_tenant_id,p_quote))');
  EXECUTE definition;
END $migration$;

CREATE FUNCTION public.form_expiry_only_mapped_renewal_supported()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public AS $$ SELECT true $$;
REVOKE ALL ON FUNCTION public.form_expiry_only_mapped_renewal_supported() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.form_expiry_only_mapped_renewal_supported() TO service_role;
COMMIT;
