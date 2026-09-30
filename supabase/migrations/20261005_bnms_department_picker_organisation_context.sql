-- Show each candidate Department's owning Organisation in the BNMS Member
-- Department picker. Resolve the deployed model by tenant-owned endpoint shape
-- and preserve all unrelated relationship configuration.
DO $$
DECLARE
  v_tenant constant uuid := 'ff2df806-b321-4254-b651-3af11fccf1db'::uuid;
  v_department_object uuid;
  v_member_departments uuid;
  v_department_organisation uuid;
  v_existing_configuration jsonb;
  v_picker_context jsonb;
  v_source_column jsonb;
  v_next_configuration jsonb;
  v_changed_count integer;
BEGIN
  SELECT id INTO STRICT v_department_object
  FROM public.custom_object_definition
  WHERE tenant_id = v_tenant
    AND object_key = 'org_department'
    AND status = 'active';

  SELECT id, COALESCE(configuration, '{}'::jsonb)
  INTO STRICT v_member_departments, v_existing_configuration
  FROM public.custom_object_relationship_definition
  WHERE tenant_id = v_tenant
    AND relationship_key = 'members'
    AND source_kind = 'custom_object'
    AND source_custom_object_id = v_department_object
    AND target_kind = 'member'
    AND target_custom_object_id IS NULL
    AND status = 'active';

  SELECT id INTO STRICT v_department_organisation
  FROM public.custom_object_relationship_definition
  WHERE tenant_id = v_tenant
    AND relationship_key = 'organisation'
    AND source_kind = 'custom_object'
    AND source_custom_object_id = v_department_object
    AND target_kind = 'organization'
    AND target_custom_object_id IS NULL
    AND status = 'active';

  IF jsonb_typeof(v_existing_configuration) <> 'object' THEN
    RAISE EXCEPTION 'BNMS Department-to-Member relationship configuration must be a JSON object';
  END IF;

  IF v_existing_configuration ? 'picker_context'
     AND jsonb_typeof(v_existing_configuration->'picker_context') <> 'object' THEN
    RAISE EXCEPTION 'BNMS Department-to-Member picker_context must be a JSON object';
  END IF;

  v_picker_context := COALESCE(v_existing_configuration->'picker_context', '{}'::jsonb);
  v_source_column := jsonb_build_object(
    'type', 'relationship',
    'relationship_definition_id', v_department_organisation::text,
    'side', 'source',
    'label', 'Organisation'
  );
  v_next_configuration := jsonb_set(
    v_existing_configuration,
    '{picker_context}',
    jsonb_set(v_picker_context, '{source_column}', v_source_column, true),
    true
  );

  UPDATE public.custom_object_relationship_definition
  SET configuration = v_next_configuration,
      updated_at = now()
  WHERE tenant_id = v_tenant
    AND id = v_member_departments
    AND configuration IS DISTINCT FROM v_next_configuration;

  GET DIAGNOSTICS v_changed_count = ROW_COUNT;
  IF v_changed_count > 1 THEN
    RAISE EXCEPTION 'Expected at most one BNMS Department-to-Member picker context update; changed %', v_changed_count;
  END IF;
EXCEPTION
  WHEN NO_DATA_FOUND THEN
    RAISE EXCEPTION 'Expected BNMS Department, Member, or Organisation relationship model was not found';
  WHEN TOO_MANY_ROWS THEN
    RAISE EXCEPTION 'BNMS Department, Member, or Organisation relationship model is ambiguous';
END;
$$;