-- A signed-in member may open a Department current set when that Department
-- explicitly assigns the member as a Survey respondent.  Assignment is the
-- authority at this boundary; a member and Department do not need to share an
-- Organisation.
--
-- This replaces the common authorization helper only.  Session, audience, and
-- authenticated-wrapper checks remain in the earlier auth migration.

CREATE OR REPLACE FUNCTION public.department_current_set_assert_authorized(
  p_tenant_id uuid, p_department_id uuid, p_member_id uuid, p_config jsonb
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Keep the common helper tenant-scoped for service-role callers as well.
  -- Organisation membership is deliberately not consulted.
  IF NOT EXISTS (
    SELECT 1
    FROM public.member member
    WHERE member.id = p_member_id
      AND member.tenant_id = p_tenant_id
  ) THEN
    RAISE EXCEPTION 'CURRENT_SET_AUTHORIZATION: member is not in this tenant'
      USING ERRCODE = '42501';
  END IF;

  -- Require the requested Department and respondent edge to be live in the
  -- requested tenant.  The relationship definition is pinned by both its
  -- configured id and its complete endpoint contract; labels or a browser
  -- supplied edge cannot grant access.
  IF NOT EXISTS (
    SELECT 1
    FROM public.custom_object_record department
    JOIN public.custom_object_relationship edge
      ON edge.tenant_id = department.tenant_id
     AND edge.source_record_id = department.id
     AND edge.relationship_definition_id = (p_config->>'respondent_relationship_id')::uuid
     AND edge.target_record_id = p_member_id
     AND edge.archived_at IS NULL
     AND edge.field_values->(p_config->>'respondent_field_key') = 'true'::jsonb
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
  ) THEN
    RAISE EXCEPTION 'CURRENT_SET_AUTHORIZATION: a live Survey respondent link is required'
      USING ERRCODE = '42501';
  END IF;
END;
$$;

-- Keep the private helper signature used by both core load and reconcile.
-- Authenticated wrappers continue to perform all session and member checks
-- before this common graph authorization boundary.
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