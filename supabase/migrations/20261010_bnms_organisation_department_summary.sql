-- Ordinary shared-report configuration; no changes to source membership data.
DO $$
DECLARE
  v_tenant constant uuid := 'ff2df806-b321-4254-b651-3af11fccf1db';
  v_department constant uuid := 'cd1ebfd3-3e16-4091-be5a-99992d926f2f';
  v_key constant text := 'custom_object_reports_cd1ebfd3-3e16-4091-be5a-99992d926f2f';
  v_id constant text := 'bnms_organisation_department_summary';
  v_field uuid;
  v_org uuid;
  v_members uuid;
  v_path jsonb;
  v_report jsonb;
  v_existing jsonb;
BEGIN
  -- Also serializes concurrent first-time setup when no settings row exists.
  PERFORM pg_advisory_xact_lock(hashtextextended(v_tenant::text || v_key, 0));
  SELECT f.id INTO STRICT v_field
  FROM public.custom_object_definition o
  JOIN public.preference_field f ON f.id = o.primary_display_field_id
    AND f.tenant_id = o.tenant_id AND f.custom_object_id = o.id
  WHERE o.id = v_department AND o.tenant_id = v_tenant
    AND o.object_key = 'org_department' AND o.status = 'active'
    AND f.entity_scope = 'custom_object' AND f.is_active = true;
  SELECT id INTO STRICT v_org FROM public.custom_object_relationship_definition
  WHERE tenant_id = v_tenant AND status = 'active'
    AND relationship_key = 'organisation' AND cardinality = 'many_to_one'
    AND source_kind = 'custom_object' AND source_custom_object_id = v_department
    AND target_kind = 'organization' AND target_custom_object_id IS NULL;
  SELECT id INTO STRICT v_members FROM public.custom_object_relationship_definition
  WHERE tenant_id = v_tenant AND status = 'active'
    AND relationship_key = 'members' AND cardinality = 'many_to_many'
    AND source_kind = 'custom_object' AND source_custom_object_id = v_department
    AND target_kind = 'member' AND target_custom_object_id IS NULL;

  v_path := jsonb_build_array(jsonb_build_object(
    'relationship_definition_id', v_org::text, 'from_side', 'target'));
  v_report := jsonb_build_object(
    'id', v_id, 'name', 'Organisation department summary', 'version', 1,
    'config', jsonb_build_object(
      'version', 2, 'start_object_id', v_department::text,
      'start_endpoint', jsonb_build_object('kind', 'organization'),
      'grain_path', v_path, 'include_empty', true, 'multi_value', 'join',
      'columns', jsonb_build_array(
        jsonb_build_object('id', 'organisation-name', 'kind', 'field',
          'path', '[]'::jsonb, 'field', 'name', 'label', 'Organisation name'),
        jsonb_build_object('id', 'department-name', 'kind', 'field',
          'path', v_path, 'field_id', v_field::text,
          'label', 'Department name', 'empty_label', 'No departments'),
        jsonb_build_object('id', 'department-member-count', 'kind', 'count_distinct',
          'path', jsonb_build_array(jsonb_build_object(
            'relationship_definition_id', v_members::text, 'from_side', 'source')),
          'label', 'Department member count')
      )
    )
  );
  SELECT COALESCE(setting_value::jsonb, '{}'::jsonb) INTO v_existing
  FROM public.system_settings
  WHERE tenant_id = v_tenant AND setting_key = v_key FOR UPDATE;
  IF FOUND THEN
    IF EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(v_existing->'reports', '[]'::jsonb)) r
      WHERE r->>'id' = v_id) THEN
      -- Never overwrite an administrator's subsequent edits on a replay.
      RETURN;
    END IF;
    UPDATE public.system_settings SET setting_value = jsonb_set(
      v_existing, '{reports}', COALESCE(v_existing->'reports', '[]'::jsonb)
        || jsonb_build_array(v_report), true)::text
    WHERE tenant_id = v_tenant AND setting_key = v_key;
  ELSE
    INSERT INTO public.system_settings(tenant_id, setting_key, setting_value, description)
    VALUES(v_tenant, v_key, jsonb_build_object('reports', jsonb_build_array(v_report))::text,
      'Shared reports for Departments');
  END IF;
END;
$$;