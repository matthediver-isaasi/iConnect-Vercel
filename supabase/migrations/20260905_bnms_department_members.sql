-- BNMS Department -> Member relationship.  This is deliberately pinned: a
-- surprising schema state must stop the migration rather than silently select
-- an arbitrary Department definition.
DO $$
DECLARE
  v_tenant uuid := 'ff2df806-b321-4254-b651-3af11fccf1db'::uuid;
  v_department_id uuid;
  v_existing public.custom_object_relationship_definition%ROWTYPE;
  v_count integer;
BEGIN
  SELECT id INTO STRICT v_department_id
  FROM public.custom_object_definition
  WHERE tenant_id = v_tenant AND object_key = 'org_department' AND status = 'active';

  SELECT count(*) INTO v_count
  FROM public.custom_object_relationship_definition
  WHERE tenant_id = v_tenant AND relationship_key = 'organisation'
    AND status = 'active' AND is_required
    AND source_kind = 'custom_object' AND source_custom_object_id = v_department_id
    AND target_kind = 'organization' AND target_custom_object_id IS NULL
    AND cardinality = 'many_to_one';
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'Expected exactly one active required BNMS Department-to-Organisation relationship; found %', v_count;
  END IF;

  SELECT count(*) INTO v_count
  FROM public.custom_object_relationship_definition
  WHERE tenant_id = v_tenant AND relationship_key = 'members';
  IF v_count > 1 THEN
    RAISE EXCEPTION 'More than one BNMS Department-to-Member relationship key exists';
  END IF;

  IF v_count = 1 THEN
    SELECT * INTO v_existing FROM public.custom_object_relationship_definition
    WHERE tenant_id = v_tenant AND relationship_key = 'members';
    IF v_existing.source_kind <> 'custom_object'
       OR v_existing.source_custom_object_id <> v_department_id
       OR v_existing.target_kind <> 'member'
       OR v_existing.target_custom_object_id IS NOT NULL
       OR v_existing.cardinality <> 'one_to_many'
       OR v_existing.source_label <> 'Members'
       OR v_existing.target_label <> 'Organisation Department'
       OR v_existing.is_required
       OR NOT v_existing.show_on_source
       OR NOT v_existing.show_on_target
       OR NOT v_existing.edit_from_source
       OR NOT v_existing.edit_from_target
       OR v_existing.status <> 'active' THEN
      RAISE EXCEPTION 'Existing BNMS members relationship does not have the expected Department-to-Member shape';
    END IF;
    IF COALESCE(v_existing.configuration, '{}'::jsonb) ? 'picker_scope'
       AND v_existing.configuration->'picker_scope' <> '{"via_relationship_key":"organisation","routed_core_field":"organization_id"}'::jsonb THEN
      RAISE EXCEPTION 'Existing BNMS members relationship has an unexpected picker scope';
    END IF;
  ELSE
    INSERT INTO public.custom_object_relationship_definition (
      tenant_id, relationship_key, source_kind, source_custom_object_id,
      target_kind, target_custom_object_id, cardinality, source_label,
      target_label, is_required, show_on_source, show_on_target,
       edit_from_source, edit_from_target, status, configuration
    ) VALUES (
      v_tenant, 'members', 'custom_object', v_department_id,
      'member', NULL, 'one_to_many', 'Members', 'Organisation Department',
       false, true, true, true, true, 'active',
       '{"picker_scope":{"via_relationship_key":"organisation","routed_core_field":"organization_id"}}'::jsonb
    );
  END IF;
  UPDATE public.custom_object_relationship_definition
  SET configuration = COALESCE(configuration, '{}'::jsonb)
        || '{"picker_scope":{"via_relationship_key":"organisation","routed_core_field":"organization_id"}}'::jsonb,
      updated_at = now()
  WHERE tenant_id = v_tenant AND relationship_key = 'members'
    AND NOT (COALESCE(configuration, '{}'::jsonb) ? 'picker_scope');
EXCEPTION
  WHEN NO_DATA_FOUND THEN
    RAISE EXCEPTION 'Expected exactly one active BNMS Department Custom Object was not found';
  WHEN TOO_MANY_ROWS THEN
    RAISE EXCEPTION 'More than one active BNMS Department Custom Object was found';
END;
$$;

-- The relationship table is generic, but this domain-specific invariant is
-- evaluated from the definition shape so all write paths (including direct
-- SQL) receive the same protection.
CREATE OR REPLACE FUNCTION public.guard_department_member_organization_consistency()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
DECLARE
  v_department_object uuid;
  v_member_org uuid;
  v_parent_count integer;
BEGIN
  IF NEW.archived_at IS NOT NULL THEN RETURN NEW; END IF;
  SELECT id INTO v_department_object FROM public.custom_object_definition
  WHERE tenant_id = NEW.tenant_id AND object_key = 'org_department' AND status = 'active';
  IF NOT FOUND THEN RETURN NEW; END IF;
  IF (SELECT count(*) FROM public.custom_object_definition
      WHERE tenant_id = NEW.tenant_id AND object_key = 'org_department' AND status = 'active') <> 1 THEN
    RAISE EXCEPTION 'BNMS Department object is ambiguous'
      USING ERRCODE = '23514', CONSTRAINT = 'bnms_department_member_schema_ambiguous';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.custom_object_relationship_definition d
    WHERE d.id = NEW.relationship_definition_id AND d.tenant_id = NEW.tenant_id
      AND d.relationship_key = 'members' AND d.status = 'active'
      AND d.source_kind = 'custom_object' AND d.source_custom_object_id = v_department_object
      AND d.target_kind = 'member' AND d.target_custom_object_id IS NULL
      AND d.cardinality = 'one_to_many'
  ) THEN RETURN NEW; END IF;
  SELECT organization_id INTO v_member_org FROM public.member
  WHERE tenant_id = NEW.tenant_id AND id = NEW.target_record_id;
  IF v_member_org IS NULL THEN
    RAISE EXCEPTION 'A Department member must belong to an organisation'
      USING ERRCODE = '23514', CONSTRAINT = 'bnms_department_member_organization_required';
  END IF;
  SELECT count(*) INTO v_parent_count
  FROM public.custom_object_relationship_definition d
  JOIN public.custom_object_relationship e
    ON e.relationship_definition_id = d.id AND e.tenant_id = d.tenant_id AND e.archived_at IS NULL
  WHERE d.tenant_id = NEW.tenant_id AND d.relationship_key = 'organisation'
    AND d.status = 'active' AND d.is_required
    AND d.source_kind = 'custom_object' AND d.source_custom_object_id = v_department_object
    AND d.target_kind = 'organization' AND e.source_record_id = NEW.source_record_id
    AND e.target_record_id = v_member_org;
  IF v_parent_count <> 1 THEN
    RAISE EXCEPTION 'Department member organisation must match the Department organisation'
      USING ERRCODE = '23514', CONSTRAINT = 'bnms_department_member_organization_match';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS bnms_department_member_relationship_guard_trigger ON public.custom_object_relationship;
DROP TRIGGER IF EXISTS department_member_organization_consistency_trigger ON public.custom_object_relationship;
CREATE TRIGGER department_member_organization_consistency_trigger
BEFORE INSERT OR UPDATE OF archived_at ON public.custom_object_relationship
FOR EACH ROW EXECUTE FUNCTION public.guard_department_member_organization_consistency();

-- Moving or clearing a member's organisation retires any now-invalid
-- Department edge.  The archived_by value makes this automatic action visible
-- in relationship history without introducing a member.department_id column.
CREATE OR REPLACE FUNCTION public.archive_invalid_bnms_member_departments()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.organization_id IS NOT DISTINCT FROM OLD.organization_id THEN RETURN NEW; END IF;
  UPDATE public.custom_object_relationship e
  SET archived_at = now(), archived_by = 'system:member_organization_change'
  FROM public.custom_object_relationship_definition d
  JOIN public.custom_object_definition o ON o.id = d.source_custom_object_id AND o.tenant_id = d.tenant_id
  WHERE e.tenant_id = NEW.tenant_id AND e.relationship_definition_id = d.id
    AND e.target_record_id = NEW.id AND e.archived_at IS NULL
    AND d.status = 'active' AND d.relationship_key = 'members'
    AND d.source_kind = 'custom_object' AND d.target_kind = 'member'
    AND d.target_custom_object_id IS NULL AND d.cardinality = 'one_to_many'
    AND o.object_key = 'org_department'
    AND NOT EXISTS (
      SELECT 1 FROM public.custom_object_relationship parent
      JOIN public.custom_object_relationship_definition pd ON pd.id = parent.relationship_definition_id
      WHERE parent.tenant_id = NEW.tenant_id AND parent.archived_at IS NULL
        AND pd.tenant_id = NEW.tenant_id AND pd.status = 'active' AND pd.is_required
        AND pd.relationship_key = 'organisation' AND pd.source_custom_object_id = d.source_custom_object_id
        AND pd.target_kind = 'organization' AND parent.source_record_id = e.source_record_id
        AND parent.target_record_id = NEW.organization_id
    );
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS archive_invalid_bnms_member_departments_trigger ON public.member;
CREATE TRIGGER archive_invalid_bnms_member_departments_trigger
AFTER UPDATE OF organization_id ON public.member
FOR EACH ROW EXECUTE FUNCTION public.archive_invalid_bnms_member_departments();

REVOKE ALL ON FUNCTION public.guard_department_member_organization_consistency() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.archive_invalid_bnms_member_departments() FROM PUBLIC, anon, authenticated;