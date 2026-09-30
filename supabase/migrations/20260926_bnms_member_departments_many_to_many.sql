-- Widen the already-deployed BNMS Department -> Member relationship without
-- replacing its definition or any active/archived edge history.
DO $$
DECLARE
  v_tenant uuid := 'ff2df806-b321-4254-b651-3af11fccf1db'::uuid;
  v_department_id uuid;
  v_existing public.custom_object_relationship_definition%ROWTYPE;
  v_count integer;
  v_changed_count integer;
BEGIN
  SELECT id INTO STRICT v_department_id
  FROM public.custom_object_definition
  WHERE tenant_id = v_tenant
    AND object_key = 'org_department'
    AND status = 'active';

  SELECT count(*) INTO v_count
  FROM public.custom_object_relationship_definition
  WHERE tenant_id = v_tenant
    AND relationship_key = 'organisation'
    AND status = 'active'
    AND is_required
    AND source_kind = 'custom_object'
    AND source_custom_object_id = v_department_id
    AND target_kind = 'organization'
    AND target_custom_object_id IS NULL
    AND cardinality = 'many_to_one';
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'Expected exactly one active required BNMS Department-to-Organisation relationship; found %', v_count;
  END IF;

  SELECT * INTO STRICT v_existing
  FROM public.custom_object_relationship_definition
  WHERE tenant_id = v_tenant
    AND relationship_key = 'members';

  IF v_existing.source_kind <> 'custom_object'
     OR v_existing.source_custom_object_id <> v_department_id
     OR v_existing.target_kind <> 'member'
     OR v_existing.target_custom_object_id IS NOT NULL
     OR v_existing.cardinality NOT IN ('one_to_many', 'many_to_many')
     OR v_existing.source_label <> 'Members'
     OR (
       (v_existing.cardinality = 'one_to_many' AND v_existing.target_label <> 'Organisation Department')
       OR (v_existing.cardinality = 'many_to_many' AND v_existing.target_label <> 'Organisation Departments')
     )
     OR v_existing.is_required
     OR NOT v_existing.show_on_source
     OR NOT v_existing.show_on_target
     OR NOT v_existing.edit_from_source
     OR NOT v_existing.edit_from_target
     OR v_existing.status <> 'active' THEN
    RAISE EXCEPTION 'Existing BNMS members relationship does not have the expected Department-to-Member shape';
  END IF;

  IF COALESCE(v_existing.configuration, '{}'::jsonb) ? 'picker_scope'
     AND v_existing.configuration->'picker_scope'
       <> '{"via_relationship_key":"organisation","routed_core_field":"organization_id"}'::jsonb THEN
    RAISE EXCEPTION 'Existing BNMS members relationship has an unexpected picker scope';
  END IF;

  -- Refuse to widen while any existing active edge violates the ownership
  -- invariant. This prevents a cardinality change from legitimising stale,
  -- cross-Organisation data.
  SELECT count(*) INTO v_count
  FROM public.custom_object_relationship e
  LEFT JOIN public.member m
    ON m.id = e.target_record_id
   AND m.tenant_id = e.tenant_id
  WHERE e.tenant_id = v_tenant
    AND e.relationship_definition_id = v_existing.id
    AND e.archived_at IS NULL
    AND (
      m.id IS NULL
      OR m.organization_id IS NULL
      OR (
        SELECT count(*)
        FROM public.custom_object_relationship_definition pd
        JOIN public.custom_object_relationship parent
          ON parent.relationship_definition_id = pd.id
         AND parent.tenant_id = pd.tenant_id
         AND parent.archived_at IS NULL
        WHERE pd.tenant_id = v_tenant
          AND pd.relationship_key = 'organisation'
          AND pd.status = 'active'
          AND pd.is_required
          AND pd.source_kind = 'custom_object'
          AND pd.source_custom_object_id = v_department_id
          AND pd.target_kind = 'organization'
          AND pd.target_custom_object_id IS NULL
          AND pd.cardinality = 'many_to_one'
          AND parent.source_record_id = e.source_record_id
      ) <> 1
      OR NOT EXISTS (
        SELECT 1
        FROM public.custom_object_relationship_definition pd
        JOIN public.custom_object_relationship parent
          ON parent.relationship_definition_id = pd.id
         AND parent.tenant_id = pd.tenant_id
         AND parent.archived_at IS NULL
        WHERE pd.tenant_id = v_tenant
          AND pd.relationship_key = 'organisation'
          AND pd.status = 'active'
          AND pd.is_required
          AND pd.source_kind = 'custom_object'
          AND pd.source_custom_object_id = v_department_id
          AND pd.target_kind = 'organization'
          AND pd.target_custom_object_id IS NULL
          AND pd.cardinality = 'many_to_one'
          AND parent.source_record_id = e.source_record_id
          AND parent.target_record_id = m.organization_id
      )
    );
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'Found % active BNMS Department-to-Member edges with inconsistent organisation ownership', v_count;
  END IF;

  IF v_existing.cardinality = 'one_to_many' THEN
    -- Cardinality is normally immutable. This fully pinned migration is the
    -- controlled exception and preserves the definition ID and edge history.
    ALTER TABLE public.custom_object_relationship_definition
      DISABLE TRIGGER custom_object_relationship_definition_guard_trigger;

    UPDATE public.custom_object_relationship_definition
    SET cardinality = 'many_to_many',
        target_label = 'Organisation Departments',
        configuration = COALESCE(configuration, '{}'::jsonb)
          || '{"picker_scope":{"via_relationship_key":"organisation","routed_core_field":"organization_id"}}'::jsonb,
        updated_at = now()
    WHERE id = v_existing.id
      AND tenant_id = v_tenant
      AND cardinality = 'one_to_many';
    GET DIAGNOSTICS v_changed_count = ROW_COUNT;

    ALTER TABLE public.custom_object_relationship_definition
      ENABLE TRIGGER custom_object_relationship_definition_guard_trigger;

    IF v_changed_count <> 1 THEN
      RAISE EXCEPTION 'Expected exactly one BNMS Department-to-Member relationship update; changed %', v_changed_count;
    END IF;
  ELSE
    UPDATE public.custom_object_relationship_definition
    SET configuration = COALESCE(configuration, '{}'::jsonb)
          || '{"picker_scope":{"via_relationship_key":"organisation","routed_core_field":"organization_id"}}'::jsonb,
        updated_at = now()
    WHERE id = v_existing.id
      AND NOT (COALESCE(configuration, '{}'::jsonb) ? 'picker_scope');
  END IF;
EXCEPTION
  WHEN NO_DATA_FOUND THEN
    RAISE EXCEPTION 'Expected BNMS Department object or members relationship was not found';
  WHEN TOO_MANY_ROWS THEN
    RAISE EXCEPTION 'BNMS Department object or members relationship is ambiguous';
END;
$$;

-- All relationship write paths, including direct SQL, must enforce the same
-- tenant and Organisation ownership boundary.
CREATE OR REPLACE FUNCTION public.guard_department_member_organization_consistency()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_department_object uuid;
  v_member_org uuid;
  v_parent_count integer;
  v_matching_parent_count integer;
BEGIN
  IF NEW.archived_at IS NOT NULL THEN
    RETURN NEW;
  END IF;

  SELECT id INTO v_department_object
  FROM public.custom_object_definition
  WHERE tenant_id = NEW.tenant_id
    AND object_key = 'org_department'
    AND status = 'active';
  IF NOT FOUND THEN
    RETURN NEW;
  END IF;
  IF (
    SELECT count(*)
    FROM public.custom_object_definition
    WHERE tenant_id = NEW.tenant_id
      AND object_key = 'org_department'
      AND status = 'active'
  ) <> 1 THEN
    RAISE EXCEPTION 'BNMS Department object is ambiguous'
      USING ERRCODE = '23514', CONSTRAINT = 'bnms_department_member_schema_ambiguous';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.custom_object_relationship_definition d
    WHERE d.id = NEW.relationship_definition_id
      AND d.tenant_id = NEW.tenant_id
      AND d.relationship_key = 'members'
      AND d.status = 'active'
      AND d.source_kind = 'custom_object'
      AND d.source_custom_object_id = v_department_object
      AND d.target_kind = 'member'
      AND d.target_custom_object_id IS NULL
      AND d.cardinality IN ('one_to_many', 'many_to_many')
  ) THEN
    RETURN NEW;
  END IF;

  SELECT organization_id INTO v_member_org
  FROM public.member
  WHERE tenant_id = NEW.tenant_id
    AND id = NEW.target_record_id;
  IF v_member_org IS NULL THEN
    RAISE EXCEPTION 'A Department member must belong to an organisation'
      USING ERRCODE = '23514', CONSTRAINT = 'bnms_department_member_organization_required';
  END IF;

  SELECT
    count(*),
    count(*) FILTER (WHERE e.target_record_id = v_member_org)
  INTO v_parent_count, v_matching_parent_count
  FROM public.custom_object_relationship_definition d
  JOIN public.custom_object_relationship e
    ON e.relationship_definition_id = d.id
   AND e.tenant_id = d.tenant_id
   AND e.archived_at IS NULL
  WHERE d.tenant_id = NEW.tenant_id
    AND d.relationship_key = 'organisation'
    AND d.status = 'active'
    AND d.is_required
    AND d.source_kind = 'custom_object'
    AND d.source_custom_object_id = v_department_object
    AND d.target_kind = 'organization'
    AND d.target_custom_object_id IS NULL
    AND d.cardinality = 'many_to_one'
    AND e.source_record_id = NEW.source_record_id;
  IF v_parent_count <> 1 OR v_matching_parent_count <> 1 THEN
    RAISE EXCEPTION 'Department member organisation must match the Department organisation'
      USING ERRCODE = '23514', CONSTRAINT = 'bnms_department_member_organization_match';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS bnms_department_member_relationship_guard_trigger
  ON public.custom_object_relationship;
DROP TRIGGER IF EXISTS department_member_organization_consistency_trigger
  ON public.custom_object_relationship;
CREATE TRIGGER department_member_organization_consistency_trigger
BEFORE INSERT OR UPDATE OF archived_at ON public.custom_object_relationship
FOR EACH ROW EXECUTE FUNCTION public.guard_department_member_organization_consistency();

-- Moving or clearing a Member's Organisation retires every Department edge
-- whose Department no longer belongs to that Organisation.
CREATE OR REPLACE FUNCTION public.archive_invalid_bnms_member_departments()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.organization_id IS NOT DISTINCT FROM OLD.organization_id THEN
    RETURN NEW;
  END IF;

  UPDATE public.custom_object_relationship e
  SET archived_at = now(),
      archived_by = 'system:member_organization_change'
  FROM public.custom_object_relationship_definition d
  JOIN public.custom_object_definition o
    ON o.id = d.source_custom_object_id
   AND o.tenant_id = d.tenant_id
  WHERE e.tenant_id = NEW.tenant_id
    AND e.relationship_definition_id = d.id
    AND e.target_record_id = NEW.id
    AND e.archived_at IS NULL
    AND d.status = 'active'
    AND d.relationship_key = 'members'
    AND d.source_kind = 'custom_object'
    AND d.target_kind = 'member'
    AND d.target_custom_object_id IS NULL
    AND d.cardinality IN ('one_to_many', 'many_to_many')
    AND o.object_key = 'org_department'
    AND NOT EXISTS (
      SELECT 1
      FROM public.custom_object_relationship parent
      JOIN public.custom_object_relationship_definition pd
        ON pd.id = parent.relationship_definition_id
      WHERE parent.tenant_id = NEW.tenant_id
        AND parent.archived_at IS NULL
        AND pd.tenant_id = NEW.tenant_id
        AND pd.status = 'active'
        AND pd.is_required
        AND pd.relationship_key = 'organisation'
        AND pd.source_custom_object_id = d.source_custom_object_id
        AND pd.target_kind = 'organization'
        AND parent.source_record_id = e.source_record_id
        AND parent.target_record_id = NEW.organization_id
    );
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS archive_invalid_bnms_member_departments_trigger
  ON public.member;
CREATE TRIGGER archive_invalid_bnms_member_departments_trigger
AFTER UPDATE OF organization_id ON public.member
FOR EACH ROW EXECUTE FUNCTION public.archive_invalid_bnms_member_departments();

REVOKE ALL ON FUNCTION public.guard_department_member_organization_consistency()
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.archive_invalid_bnms_member_departments()
  FROM PUBLIC, anon, authenticated;