-- BNMS Organisation departments: permit many departments to reference one
-- Organisation while retaining the required one-Organisation-per-department
-- rule. This data migration is deliberately pinned to the known tenant,
-- object, relationship key, endpoints, and current cardinality.
DO $$
DECLARE
  relationship public.custom_object_relationship_definition%ROWTYPE;
  changed_count integer;
BEGIN
  SELECT definition.* INTO STRICT relationship
  FROM public.custom_object_relationship_definition definition
    JOIN public.custom_object_definition object_definition
      ON object_definition.id = definition.source_custom_object_id
     AND object_definition.tenant_id = definition.tenant_id
  WHERE definition.tenant_id = 'ff2df806-b321-4254-b651-3af11fccf1db'::uuid
    AND definition.relationship_key = 'organisation'
    AND definition.source_kind = 'custom_object'
    AND object_definition.object_key = 'org_department'
    AND definition.target_kind = 'organization'
    AND definition.target_custom_object_id IS NULL
    AND definition.cardinality IN ('one_to_one', 'many_to_one')
    AND definition.is_required = true
    AND definition.status = 'active';

  IF relationship.cardinality = 'one_to_one' THEN
    ALTER TABLE public.custom_object_relationship_definition
      DISABLE TRIGGER custom_object_relationship_definition_guard_trigger;

    UPDATE public.custom_object_relationship_definition
    SET cardinality = 'many_to_one',
        updated_at = now()
    WHERE id = relationship.id
      AND tenant_id = relationship.tenant_id
      AND cardinality = 'one_to_one';
    GET DIAGNOSTICS changed_count = ROW_COUNT;

    ALTER TABLE public.custom_object_relationship_definition
      ENABLE TRIGGER custom_object_relationship_definition_guard_trigger;

    IF changed_count <> 1 THEN
      RAISE EXCEPTION 'Expected exactly one BNMS Department-to-Organisation relationship update; changed %', changed_count;
    END IF;
  END IF;
EXCEPTION
  WHEN NO_DATA_FOUND THEN
    RAISE EXCEPTION 'Expected active required BNMS Department-to-Organisation relationship was not found';
  WHEN TOO_MANY_ROWS THEN
    RAISE EXCEPTION 'More than one active required BNMS Department-to-Organisation relationship was found';
END;
$$;