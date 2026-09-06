-- Seed the shared BNMS Department member report from the live, validated
-- relationship schema. Existing shared reports are preserved byte-for-byte.
DO $$
DECLARE
  v_tenant constant uuid := 'ff2df806-b321-4254-b651-3af11fccf1db'::uuid;
  v_department constant uuid := 'cd1ebfd3-3e16-4091-be5a-99992d926f2f'::uuid;
  v_setting_key constant text := 'custom_object_reports_cd1ebfd3-3e16-4091-be5a-99992d926f2f';
  v_report_id constant text := 'bnms_department_members';
  v_name_field public.preference_field%ROWTYPE;
  v_organisation public.custom_object_relationship_definition%ROWTYPE;
  v_members public.custom_object_relationship_definition%ROWTYPE;
  v_responder jsonb;
  v_report jsonb;
  v_existing jsonb;
BEGIN
  PERFORM 1 FROM public.custom_object_definition
  WHERE id = v_department AND tenant_id = v_tenant
    AND object_key = 'org_department' AND status = 'active';
  IF NOT FOUND THEN RAISE EXCEPTION 'Expected active pinned BNMS Department object was not found'; END IF;

  SELECT field.* INTO STRICT v_name_field
  FROM public.custom_object_definition object_definition
  JOIN public.preference_field field
    ON field.id = object_definition.primary_display_field_id
   AND field.tenant_id = object_definition.tenant_id
  WHERE object_definition.id = v_department
    AND object_definition.tenant_id = v_tenant
    AND field.custom_object_id = v_department
    AND field.entity_scope = 'custom_object'
    AND field.is_active = true;

  SELECT * INTO STRICT v_organisation
  FROM public.custom_object_relationship_definition
  WHERE tenant_id = v_tenant AND status = 'active'
    AND relationship_key = 'organisation'
    AND source_kind = 'custom_object' AND source_custom_object_id = v_department
    AND target_kind = 'organization' AND target_custom_object_id IS NULL
    AND cardinality = 'many_to_one';

  SELECT * INTO STRICT v_members
  FROM public.custom_object_relationship_definition
  WHERE tenant_id = v_tenant AND status = 'active'
    AND relationship_key = 'members'
    AND source_kind = 'custom_object' AND source_custom_object_id = v_department
    AND target_kind = 'member' AND target_custom_object_id IS NULL
    AND cardinality = 'many_to_many';

  SELECT value INTO STRICT v_responder
  FROM jsonb_array_elements(COALESCE(
    v_members.configuration->'relationship_fields',
    v_members.configuration->'relationshipFields',
    '[]'::jsonb
  ))
  WHERE COALESCE(value->>'type', value->>'field_type') = 'boolean'
    AND (
      COALESCE(value->>'key', value->>'name') ~* 'survey.*respond'
      OR value->>'label' ~* 'survey.*respond'
    );
  IF COALESCE(v_responder->>'id', v_responder->>'field_id', '') = '' THEN
    RAISE EXCEPTION 'BNMS Department survey responder relationship field has no ID';
  END IF;

  v_report := jsonb_build_object(
    'id', v_report_id,
    'name', 'Department members',
    'version', 1,
    'config', jsonb_build_object(
      'version', 1,
      'start_object_id', v_department::text,
      'grain_path', jsonb_build_array(jsonb_build_object(
        'relationship_definition_id', v_members.id::text, 'from_side', 'source'
      )),
      'multi_value', 'join',
      'columns', jsonb_build_array(
        jsonb_build_object('id', 'organisation-id', 'kind', 'field', 'path', jsonb_build_array(jsonb_build_object('relationship_definition_id', v_organisation.id::text, 'from_side', 'source')), 'field', 'id', 'label', 'Organisation ID'),
        jsonb_build_object('id', 'organisation-name', 'kind', 'field', 'path', jsonb_build_array(jsonb_build_object('relationship_definition_id', v_organisation.id::text, 'from_side', 'source')), 'field', 'name', 'label', 'Organisation Name'),
        jsonb_build_object('id', 'department-id', 'kind', 'field', 'path', '[]'::jsonb, 'field', 'id', 'label', 'Department ID'),
        jsonb_build_object('id', 'department-name', 'kind', 'field', 'path', '[]'::jsonb, 'field_id', v_name_field.id::text, 'label', 'Department Name'),
        jsonb_build_object('id', 'member-id', 'kind', 'field', 'path', jsonb_build_array(jsonb_build_object('relationship_definition_id', v_members.id::text, 'from_side', 'source')), 'field', 'id', 'label', 'Member ID'),
        jsonb_build_object('id', 'member-first-name', 'kind', 'field', 'path', jsonb_build_array(jsonb_build_object('relationship_definition_id', v_members.id::text, 'from_side', 'source')), 'field', 'first_name', 'label', 'Member first name'),
        jsonb_build_object('id', 'member-last-name', 'kind', 'field', 'path', jsonb_build_array(jsonb_build_object('relationship_definition_id', v_members.id::text, 'from_side', 'source')), 'field', 'last_name', 'label', 'Member last name'),
        jsonb_build_object('id', 'member-email', 'kind', 'field', 'path', jsonb_build_array(jsonb_build_object('relationship_definition_id', v_members.id::text, 'from_side', 'source')), 'field', 'email', 'label', 'Member email'),
        jsonb_build_object('id', 'department-survey-responder', 'kind', 'relationship_field', 'path', jsonb_build_array(jsonb_build_object('relationship_definition_id', v_members.id::text, 'from_side', 'source')), 'relationship_definition_id', v_members.id::text, 'relationship_field_id', COALESCE(v_responder->>'id', v_responder->>'field_id'), 'field_key', COALESCE(v_responder->>'key', v_responder->>'name'), 'label', 'department survey responder')
      )
    )
  );

  SELECT COALESCE(setting_value::jsonb, '{}'::jsonb) INTO v_existing
  FROM public.system_settings
  WHERE tenant_id = v_tenant AND setting_key = v_setting_key
  FOR UPDATE;

  IF FOUND THEN
    IF EXISTS (
      SELECT 1 FROM jsonb_array_elements(COALESCE(v_existing->'reports', '[]'::jsonb)) report
      WHERE report->>'id' = v_report_id
    ) THEN
      IF NOT EXISTS (
        SELECT 1 FROM jsonb_array_elements(COALESCE(v_existing->'reports', '[]'::jsonb)) report
        WHERE report = v_report
      ) THEN
        RAISE EXCEPTION 'Existing BNMS Department members report differs from the expected definition';
      END IF;
    ELSE
      UPDATE public.system_settings
      SET setting_value = jsonb_set(
        v_existing,
        '{reports}',
        COALESCE(v_existing->'reports', '[]'::jsonb) || jsonb_build_array(v_report),
        true
      )::text
      WHERE tenant_id = v_tenant AND setting_key = v_setting_key;
    END IF;
  ELSE
    INSERT INTO public.system_settings (tenant_id, setting_key, setting_value, description)
    VALUES (
      v_tenant, v_setting_key,
      jsonb_build_object('reports', jsonb_build_array(v_report))::text,
      'Shared reports for Departments'
    );
  END IF;
EXCEPTION
  WHEN NO_DATA_FOUND THEN
    RAISE EXCEPTION 'Expected BNMS Department report schema component was not found';
  WHEN TOO_MANY_ROWS THEN
    RAISE EXCEPTION 'BNMS Department report schema component is ambiguous';
END;
$$;