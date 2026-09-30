-- Task #4375 follow-up: the strict DD initializer must not commit a mapped
-- organization/preference value unless the old/new workflow fanout payload is
-- committed in the same transaction.
CREATE OR REPLACE FUNCTION public.apply_form_due_diligence_field_mapping_with_outbox(
  p_tenant_id UUID,
  p_due_diligence_submission_id UUID,
  p_event_key TEXT,
  p_event_type TEXT,
  p_organization_id UUID,
  p_mutation JSONB DEFAULT '{}'::JSONB,
  p_preference_field_id UUID DEFAULT NULL,
  p_preference_value TEXT DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_organization public.organization%ROWTYPE;
  v_updated_organization public.organization%ROWTYPE;
  v_before JSONB;
  v_after JSONB;
  v_preference_value TEXT;
  v_preference_exists BOOLEAN := FALSE;
BEGIN
  IF p_event_type NOT IN ('core', 'preference')
     OR NULLIF(BTRIM(p_event_key), '') IS NULL THEN
    RAISE EXCEPTION 'invalid field-mapping workflow outbox event' USING ERRCODE = '22023';
  END IF;

  PERFORM 1
    FROM public.form_submission_due_diligence
   WHERE id = p_due_diligence_submission_id
     AND tenant_id = p_tenant_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'due-diligence submission is not tenant-owned' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO v_organization
    FROM public.organization
   WHERE id = p_organization_id
     AND tenant_id = p_tenant_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'organization is not tenant-owned' USING ERRCODE = 'P0001';
  END IF;

  IF p_event_type = 'core' THEN
    IF EXISTS (
      SELECT 1
        FROM jsonb_object_keys(COALESCE(p_mutation, '{}'::JSONB)) AS key_name
       WHERE key_name NOT IN (
         'name', 'email', 'invoicing_email', 'phone', 'website_url',
         'description', 'logo_url', 'invoicing_address', 'address'
       )
    ) THEN
      RAISE EXCEPTION 'invalid organization field-mapping mutation' USING ERRCODE = '22023';
    END IF;

    v_before := to_jsonb(v_organization);
    v_updated_organization := jsonb_populate_record(v_organization, COALESCE(p_mutation, '{}'::JSONB));
    IF v_before IS NOT DISTINCT FROM to_jsonb(v_updated_organization) THEN
      RETURN jsonb_build_object('applied', FALSE, 'created', FALSE, 'after', v_before);
    END IF;

    UPDATE public.organization AS org
       SET name = v_updated_organization.name,
           email = v_updated_organization.email,
           invoicing_email = v_updated_organization.invoicing_email,
           phone = v_updated_organization.phone,
           website_url = v_updated_organization.website_url,
           description = v_updated_organization.description,
           logo_url = v_updated_organization.logo_url,
           invoicing_address = v_updated_organization.invoicing_address,
           address = v_updated_organization.address
     WHERE id = p_organization_id
       AND tenant_id = p_tenant_id
     RETURNING to_jsonb(org) INTO v_after;

    INSERT INTO public.form_due_diligence_field_mapping_workflow_outbox (
      form_submission_due_diligence_id, tenant_id, event_key, event_type,
      organization_id, payload
    ) VALUES (
      p_due_diligence_submission_id, p_tenant_id, p_event_key, 'core',
      p_organization_id, jsonb_build_object('before', v_before, 'after', v_after)
    ) ON CONFLICT (form_submission_due_diligence_id, event_key) DO NOTHING;

    RETURN jsonb_build_object(
      'applied', TRUE, 'created', FALSE, 'before', v_before, 'after', v_after
    );
  END IF;

  IF p_preference_field_id IS NULL THEN
    RAISE EXCEPTION 'preference field is required' USING ERRCODE = '22023';
  END IF;
  SELECT value INTO v_preference_value
    FROM public.organization_preference_value
   WHERE organization_id = p_organization_id
     AND field_id = p_preference_field_id
   FOR UPDATE;
  v_preference_exists := FOUND;
  IF v_preference_exists
     AND v_preference_value IS NOT DISTINCT FROM p_preference_value THEN
    RETURN jsonb_build_object('applied', FALSE, 'created', FALSE);
  END IF;

  IF v_preference_exists THEN
    UPDATE public.organization_preference_value
       SET value = p_preference_value, updated_at = NOW()
     WHERE organization_id = p_organization_id
       AND field_id = p_preference_field_id;
  ELSE
    INSERT INTO public.organization_preference_value (
      organization_id, field_id, value
    ) VALUES (
      p_organization_id, p_preference_field_id, p_preference_value
    );
  END IF;

  INSERT INTO public.form_due_diligence_field_mapping_workflow_outbox (
    form_submission_due_diligence_id, tenant_id, event_key, event_type,
    organization_id, payload
  ) VALUES (
    p_due_diligence_submission_id, p_tenant_id, p_event_key, 'preference',
    p_organization_id,
    jsonb_build_object(
      'field_id', p_preference_field_id,
      'previous_value', v_preference_value,
      'new_value', p_preference_value
    )
  ) ON CONFLICT (form_submission_due_diligence_id, event_key) DO NOTHING;

  RETURN jsonb_build_object(
    'applied', TRUE, 'created', NOT v_preference_exists,
    'previous_value', v_preference_value, 'new_value', p_preference_value
  );
END;
$$;

REVOKE ALL ON FUNCTION public.apply_form_due_diligence_field_mapping_with_outbox(
  UUID, UUID, TEXT, TEXT, UUID, JSONB, UUID, TEXT
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.apply_form_due_diligence_field_mapping_with_outbox(
  UUID, UUID, TEXT, TEXT, UUID, JSONB, UUID, TEXT
) TO service_role;