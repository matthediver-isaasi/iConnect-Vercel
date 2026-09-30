-- Current-set URLs can name a Department directly.  The respondent flag is
-- necessary but is not sufficient authority: keep the same Organisation fence
-- used by Department pickers at the SQL mutation/read boundary.
--
-- This follows the direct-workforce migration and changes no records, edges,
-- metadata, or current-set configuration.

CREATE OR REPLACE FUNCTION public.department_current_set_assert_authorized(
  p_tenant_id uuid, p_department_id uuid, p_member_id uuid, p_config jsonb
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_member_organization_id uuid;
  v_parent_definition_count integer;
  v_parent_edge_count integer;
  v_matching_parent_count integer;
BEGIN
  -- Keep the original exact respondent-edge requirement, including active
  -- Department and definition endpoint checks.
  IF NOT EXISTS (
    SELECT 1
    FROM public.custom_object_record department
    JOIN public.custom_object_relationship edge
      ON edge.tenant_id = department.tenant_id
     AND edge.source_record_id = department.id
     AND edge.relationship_definition_id = (p_config->>'respondent_relationship_id')::uuid
     AND edge.target_record_id = p_member_id
     AND edge.archived_at IS NULL
    JOIN public.custom_object_relationship_definition definition
      ON definition.id = edge.relationship_definition_id
     AND definition.tenant_id = edge.tenant_id
     AND definition.status = 'active'
     AND definition.source_kind = 'custom_object'
     AND definition.source_custom_object_id = (p_config->>'department_object_id')::uuid
     AND definition.target_kind = 'member'
     AND definition.target_custom_object_id IS NULL
    WHERE department.tenant_id = p_tenant_id
      AND department.id = p_department_id
      AND department.custom_object_id = (p_config->>'department_object_id')::uuid
      AND department.archived_at IS NULL
      AND edge.field_values->(p_config->>'respondent_field_key') = 'true'::jsonb
  ) THEN
    RAISE EXCEPTION 'CURRENT_SET_AUTHORIZATION: a live Survey respondent link is required'
      USING ERRCODE = '42501';
  END IF;

  -- Do not trust a session's or browser's organisation claim. The member and
  -- organisation rows are tenant-scoped durable state, and a direct tenant
  -- member with no organisation is not eligible for Department current data.
  SELECT member.organization_id
    INTO v_member_organization_id
    FROM public.member member
    WHERE member.id = p_member_id
      AND member.tenant_id = p_tenant_id
    FOR SHARE;
  IF v_member_organization_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.organization organization
    WHERE organization.id = v_member_organization_id
      AND organization.tenant_id = p_tenant_id
  ) THEN
    RAISE EXCEPTION 'CURRENT_SET_AUTHORIZATION: member has no active Department organisation'
      USING ERRCODE = '42501';
  END IF;

  -- Resolve the picker contract, rather than accepting any edge whose label
  -- happens to say Organisation. An ambiguous/stale parent definition fails
  -- closed before inspecting the requested Department.
  SELECT count(*)
    INTO v_parent_definition_count
    FROM public.custom_object_relationship_definition definition
    WHERE definition.tenant_id = p_tenant_id
      AND definition.relationship_key = 'organisation'
      AND definition.status = 'active'
      AND definition.is_required
      AND definition.source_kind = 'custom_object'
      AND definition.source_custom_object_id = (p_config->>'department_object_id')::uuid
      AND definition.target_kind = 'organization'
      AND definition.target_custom_object_id IS NULL
      AND definition.cardinality = 'many_to_one';
  IF v_parent_definition_count <> 1 THEN
    RAISE EXCEPTION 'CURRENT_SET_AUTHORIZATION: Department organisation relationship is unavailable'
      USING ERRCODE = '42501';
  END IF;

  -- The requested Department must have exactly one active parent edge through
  -- that strict definition, to a real tenant-local Organization, and that
  -- endpoint must be this member's Organization. This rejects stale direct URL
  -- access, duplicate edges, and multi-organisation ownership.
  SELECT count(*),
         count(*) FILTER (
           WHERE parent.target_record_id = v_member_organization_id
             AND organization.id IS NOT NULL
         )
    INTO v_parent_edge_count, v_matching_parent_count
    FROM public.custom_object_relationship_definition definition
    JOIN public.custom_object_relationship parent
      ON parent.relationship_definition_id = definition.id
     AND parent.tenant_id = definition.tenant_id
     AND parent.archived_at IS NULL
    LEFT JOIN public.organization organization
      ON organization.id = parent.target_record_id
     AND organization.tenant_id = parent.tenant_id
    WHERE definition.tenant_id = p_tenant_id
      AND definition.relationship_key = 'organisation'
      AND definition.status = 'active'
      AND definition.is_required
      AND definition.source_kind = 'custom_object'
      AND definition.source_custom_object_id = (p_config->>'department_object_id')::uuid
      AND definition.target_kind = 'organization'
      AND definition.target_custom_object_id IS NULL
      AND definition.cardinality = 'many_to_one'
      AND parent.source_record_id = p_department_id;
  IF v_parent_edge_count <> 1 OR v_matching_parent_count <> 1 THEN
    RAISE EXCEPTION 'CURRENT_SET_AUTHORIZATION: Department is not assigned to this member organisation'
      USING ERRCODE = '42501';
  END IF;
END;
$$;

-- Keep the original private helper signature used by both core load and
-- reconcile. Replacing it makes the organisation authorization check common
-- to service-role and authenticated wrapper paths without duplicating logic.
CREATE OR REPLACE FUNCTION public.department_current_set_assert_respondent(
  p_tenant_id uuid, p_department_id uuid, p_member_id uuid, p_config jsonb
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM public.department_current_set_assert_authorized(
    p_tenant_id, p_department_id, p_member_id, p_config
  );
END;
$$;

REVOKE ALL ON FUNCTION public.department_current_set_assert_authorized(uuid, uuid, uuid, jsonb)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.department_current_set_assert_respondent(uuid, uuid, uuid, jsonb)
  FROM PUBLIC, anon, authenticated;

NOTIFY pgrst, 'reload schema';