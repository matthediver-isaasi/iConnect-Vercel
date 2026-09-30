-- Configure the BNMS Getting Started V2 Organisation Department field to
-- accept multiple related Departments plus the existing Other choice.
-- The exact tenant, form, and field IDs keep this data migration tenant-safe.
DO $$
DECLARE
  v_tenant constant uuid := 'ff2df806-b321-4254-b651-3af11fccf1db'::uuid;
  v_form constant uuid := '4086425b-077e-42fe-b624-558fd012071c'::uuid;
  v_field constant text := 'field_1788075892819';
  v_fields jsonb;
  v_updated_fields jsonb;
  v_match_count integer;
  v_changed_count integer;
BEGIN
  SELECT fields
  INTO STRICT v_fields
  FROM public.form
  WHERE id = v_form
    AND tenant_id = v_tenant;

  IF jsonb_typeof(v_fields) <> 'array' THEN
    RAISE EXCEPTION 'Expected BNMS Getting Started V2 form fields to be a JSON array';
  END IF;

  SELECT count(*)
  INTO v_match_count
  FROM jsonb_array_elements(v_fields) AS item(field)
  WHERE field->>'id' = v_field
    AND field->>'type' = 'relationship_dropdown'
    AND field->>'relationship_definition_id' = '30ad9dde-4b4e-4991-a7a4-8ef2b6b5138e';

  IF v_match_count <> 1 THEN
    RAISE EXCEPTION 'Expected exactly one BNMS Organisation Department relationship field; found %', v_match_count;
  END IF;

  SELECT jsonb_agg(
    CASE
      WHEN field->>'id' = v_field THEN
        jsonb_set(
          jsonb_set(field, '{selection_mode}', '"multiple"'::jsonb, true),
          '{not_listed_choice}',
          COALESCE(field->'not_listed_choice', '{}'::jsonb)
            || '{"enabled":true}'::jsonb,
          true
        )
      ELSE field
    END
    ORDER BY ordinal
  )
  INTO v_updated_fields
  FROM jsonb_array_elements(v_fields) WITH ORDINALITY AS item(field, ordinal);

  UPDATE public.form
  SET fields = v_updated_fields
  WHERE id = v_form
    AND tenant_id = v_tenant
    AND fields IS DISTINCT FROM v_updated_fields;

  GET DIAGNOSTICS v_changed_count = ROW_COUNT;
  IF v_changed_count > 1 THEN
    RAISE EXCEPTION 'Expected at most one BNMS Getting Started V2 form update; changed %', v_changed_count;
  END IF;

  -- Existing submitted answers and resumable drafts were saved while this field
  -- was single-select. Canonicalize only non-empty scalar values; arrays are
  -- already migrated, while malformed objects/booleans remain untouched so
  -- validation can continue to reject them.
  UPDATE public.form_submission
  SET submission_data = jsonb_set(
    submission_data,
    ARRAY[v_field],
    jsonb_build_array(submission_data->v_field),
    false
  )
  WHERE tenant_id = v_tenant
    AND form_id = v_form
    AND jsonb_typeof(submission_data) = 'object'
    AND submission_data ? v_field
    AND jsonb_typeof(submission_data->v_field) IN ('string', 'number')
    AND NULLIF(btrim(submission_data->>v_field), '') IS NOT NULL;

  UPDATE public.form_draft_submission
  SET draft_data = jsonb_set(
    draft_data,
    ARRAY[v_field],
    jsonb_build_array(draft_data->v_field),
    false
  )
  WHERE tenant_id = v_tenant::text
    AND form_id = v_form::text
    AND jsonb_typeof(draft_data) = 'object'
    AND draft_data ? v_field
    AND jsonb_typeof(draft_data->v_field) IN ('string', 'number')
    AND NULLIF(btrim(draft_data->>v_field), '') IS NOT NULL;
EXCEPTION
  WHEN NO_DATA_FOUND THEN
    RAISE EXCEPTION 'Expected BNMS Getting Started V2 form was not found';
  WHEN TOO_MANY_ROWS THEN
    RAISE EXCEPTION 'BNMS Getting Started V2 form identity is ambiguous';
END;
$$;