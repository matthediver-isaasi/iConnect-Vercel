-- Show each Department's owning Organisation on BNMS Member relationship cards.
-- The stable relationship IDs are discovered from exact tenant-owned endpoint
-- shapes so replays neither guess nor cross tenant boundaries.
DO $$
DECLARE
  v_tenant constant uuid := 'ff2df806-b321-4254-b651-3af11fccf1db'::uuid;
  v_department_object uuid;
  v_member_departments uuid;
  v_department_organisation uuid;
  v_columns jsonb;
  v_existing_columns jsonb;
  v_count integer;
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM public.custom_object_definition
    WHERE tenant_id = v_tenant
      AND object_key = 'org_department'
  ) THEN
    RAISE NOTICE 'Skipping BNMS Department card column configuration because its Data Studio model is absent';
    RETURN;
  END IF;

  SELECT id INTO STRICT v_department_object
  FROM public.custom_object_definition
  WHERE tenant_id = v_tenant
    AND object_key = 'org_department'
    AND status = 'active';

  SELECT id INTO STRICT v_member_departments
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

  SELECT CASE
      WHEN jsonb_typeof(configuration #> '{compact_preview,source_columns}') = 'array'
        THEN configuration #> '{compact_preview,source_columns}'
      ELSE '[]'::jsonb
    END
  INTO v_existing_columns
  FROM public.custom_object_relationship_definition
  WHERE tenant_id = v_tenant
    AND id = v_member_departments;

  SELECT COALESCE(jsonb_agg(existing_column ORDER BY ordinal), '[]'::jsonb)
  INTO v_columns
  FROM jsonb_array_elements(v_existing_columns) WITH ORDINALITY AS preserved(existing_column, ordinal)
  WHERE NOT (
    existing_column->>'type' = 'relationship'
    AND existing_column->>'relationship_definition_id' = v_department_organisation::text
    AND existing_column->>'side' = 'source'
  );

  v_columns := v_columns || jsonb_build_array(jsonb_build_object(
      'type', 'relationship',
      'relationship_definition_id', v_department_organisation::text,
      'side', 'source',
      'label', 'Organisation'
    ));

  UPDATE public.custom_object_relationship_definition
  SET configuration = jsonb_set(
        jsonb_set(
          COALESCE(configuration, '{}'::jsonb),
          '{compact_preview}',
          COALESCE(configuration->'compact_preview', '{}'::jsonb),
          true
        ),
        '{compact_preview,source_columns}',
        v_columns,
        true
      ),
      updated_at = now()
  WHERE tenant_id = v_tenant
    AND id = v_member_departments
    AND configuration #> '{compact_preview,source_columns}' IS DISTINCT FROM v_columns;

  GET DIAGNOSTICS v_count = ROW_COUNT;
  IF v_count > 1 THEN
    RAISE EXCEPTION 'Expected at most one BNMS Member Department card update; changed %', v_count;
  END IF;
EXCEPTION
  WHEN NO_DATA_FOUND THEN
    RAISE EXCEPTION 'Expected BNMS Department card relationship endpoint was not found';
  WHEN TOO_MANY_ROWS THEN
    RAISE EXCEPTION 'BNMS Department card relationship endpoint is ambiguous';
END;
$$;