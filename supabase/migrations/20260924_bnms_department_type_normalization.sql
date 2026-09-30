-- BNMS Department Type normalization.  This is intentionally tenant-pinned and
-- fail-closed: an existing object, field, or relationship is reused only when
-- it is the precise approved shape.
DO $$
DECLARE
  v_tenant uuid := 'ff2df806-b321-4254-b651-3af11fccf1db'::uuid;
  v_department uuid;
  v_type public.custom_object_definition%ROWTYPE;
  v_name public.preference_field%ROWTYPE;
  v_relationship public.custom_object_relationship_definition%ROWTYPE;
  v_count integer;
BEGIN
  SELECT id INTO STRICT v_department
  FROM public.custom_object_definition
  WHERE tenant_id = v_tenant AND object_key = 'org_department' AND status = 'active';

  SELECT count(*) INTO v_count FROM public.custom_object_definition
  WHERE tenant_id = v_tenant AND object_key = 'department_type';
  IF v_count > 1 THEN RAISE EXCEPTION 'More than one BNMS Department Type object exists'; END IF;
  IF v_count = 0 THEN
    INSERT INTO public.custom_object_definition (
      tenant_id, object_key, singular_label, plural_label, description,
      status, created_by, updated_by
    ) VALUES (
      v_tenant, 'department_type', 'Department Type', 'Department Types',
      'Reusable BNMS Department classification.', 'draft',
      'system:bnms-department-type-normalization', 'system:bnms-department-type-normalization'
    ) RETURNING * INTO v_type;
  ELSE
    SELECT * INTO v_type FROM public.custom_object_definition
    WHERE tenant_id = v_tenant AND object_key = 'department_type';
    IF v_type.status <> 'active'
       OR v_type.singular_label <> 'Department Type'
       OR v_type.plural_label <> 'Department Types'
       OR v_type.archived_at IS NOT NULL THEN
      RAISE EXCEPTION 'Existing BNMS Department Type object is incompatible';
    END IF;
  END IF;

  SELECT count(*) INTO v_count FROM public.preference_field
  WHERE tenant_id = v_tenant AND custom_object_id = v_type.id AND name = 'name';
  IF v_count > 1 THEN RAISE EXCEPTION 'More than one BNMS Department Type name field exists'; END IF;
  IF v_count = 0 THEN
    IF v_type.status <> 'draft' THEN
      RAISE EXCEPTION 'Existing active BNMS Department Type object has no approved name field';
    END IF;
    INSERT INTO public.preference_field (
      tenant_id, custom_object_id, name, label, field_type, entity_scope,
      is_active, is_required, display_order, created_by, updated_by
    ) VALUES (
      v_tenant, v_type.id, 'name', 'Name', 'text', 'custom_object',
      true, true, 0, 'system:bnms-department-type-normalization',
      'system:bnms-department-type-normalization'
    ) RETURNING * INTO v_name;
  ELSE
    SELECT * INTO v_name FROM public.preference_field
    WHERE tenant_id = v_tenant AND custom_object_id = v_type.id AND name = 'name';
    IF v_name.label <> 'Name' OR v_name.field_type <> 'text'
       OR v_name.entity_scope <> 'custom_object' OR NOT v_name.is_active
       OR NOT v_name.is_required OR v_type.primary_display_field_id <> v_name.id THEN
      RAISE EXCEPTION 'Existing BNMS Department Type name field is incompatible';
    END IF;
  END IF;

  IF v_type.status = 'draft' THEN
    UPDATE public.custom_object_definition
    SET primary_display_field_id = v_name.id, status = 'active',
        updated_by = 'system:bnms-department-type-normalization'
    WHERE id = v_type.id AND tenant_id = v_tenant;
    SELECT * INTO v_type FROM public.custom_object_definition WHERE id = v_type.id;
  END IF;

  SELECT count(*) INTO v_count FROM public.custom_object_relationship_definition
  WHERE tenant_id = v_tenant AND relationship_key = 'department_type';
  IF v_count > 1 THEN RAISE EXCEPTION 'More than one BNMS Department Type relationship exists'; END IF;
  IF v_count = 0 THEN
    INSERT INTO public.custom_object_relationship_definition (
      tenant_id, relationship_key, source_kind, source_custom_object_id,
      target_kind, target_custom_object_id, cardinality, source_label,
      target_label, is_required, show_on_source, show_on_target,
      edit_from_source, edit_from_target, status, created_by, updated_by
    ) VALUES (
      v_tenant, 'department_type', 'custom_object', v_department,
      'custom_object', v_type.id, 'many_to_one', 'Department Type',
      'Departments', true, true, true, true, true, 'active',
      'system:bnms-department-type-normalization', 'system:bnms-department-type-normalization'
    );
  ELSE
    SELECT * INTO v_relationship FROM public.custom_object_relationship_definition
    WHERE tenant_id = v_tenant AND relationship_key = 'department_type';
    IF v_relationship.source_kind <> 'custom_object'
       OR v_relationship.source_custom_object_id <> v_department
       OR v_relationship.target_kind <> 'custom_object'
       OR v_relationship.target_custom_object_id <> v_type.id
       OR v_relationship.cardinality <> 'many_to_one'
       OR v_relationship.source_label <> 'Department Type'
       OR v_relationship.target_label <> 'Departments'
       OR NOT v_relationship.is_required
       OR NOT v_relationship.show_on_source
       OR NOT v_relationship.show_on_target
       OR NOT v_relationship.edit_from_source
       OR NOT v_relationship.edit_from_target
       OR v_relationship.configuration <> '{}'::jsonb
       OR v_relationship.status <> 'active' THEN
      RAISE EXCEPTION 'Existing BNMS Department Type relationship is incompatible';
    END IF;
  END IF;
EXCEPTION
  WHEN NO_DATA_FOUND THEN
    RAISE EXCEPTION 'Expected exactly one active BNMS Department object was not found';
  WHEN TOO_MANY_ROWS THEN
    RAISE EXCEPTION 'More than one active BNMS Department object was found';
END;
$$;