-- Commit-time authentication/audience wrapper for current-set reconciliation.
-- The session id is transient: it is only used to reread the durable session
-- under locks and is never copied to a submission or commit row.
--
-- This has a separate advisory-lock domain from department_current_set_lock().
-- The latter protects the current-set graph and form metadata; this one
-- protects the authentication and audience inputs which otherwise have no
-- relationship to that graph.
CREATE OR REPLACE FUNCTION public.department_current_set_auth_lock(
  p_tenant_id text, p_exclusive boolean
) RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  IF p_tenant_id IS DISTINCT FROM 'ff2df806-b321-4254-b651-3af11fccf1db' THEN RETURN; END IF;
  IF p_exclusive THEN
    PERFORM pg_advisory_xact_lock(hashtext('department-current-set-auth:' || p_tenant_id));
  ELSE
    PERFORM pg_advisory_xact_lock_shared(hashtext('department-current-set-auth:' || p_tenant_id));
  END IF;
END;
$$;

-- Match session.js's generation() semantics: malformed, negative, and
-- non-safe-integer session values are legacy generation zero, never a grant.
CREATE OR REPLACE FUNCTION public.department_current_set_session_generation(p_value text)
RETURNS bigint
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE
    WHEN p_value ~ '^[0-9]+$'
      AND p_value::numeric <= 9007199254740991
    THEN p_value::bigint
    ELSE 0
  END;
$$;

CREATE OR REPLACE FUNCTION public.department_current_set_assert_live_actor(
  p_tenant_id uuid, p_member_id uuid, p_session_id text, p_policy jsonb
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_session_data jsonb;
  v_session_expiry timestamptz;
  v_session_tenant_id text;
  v_member_tenant_id text;
  v_member_role_id uuid;
  v_member_organization_id uuid;
  v_member_login_enabled boolean;
  v_member_membership_paused boolean;
  v_member_email text;
  v_member_found boolean := false;
  v_organization_tenant_id text;
  v_organization_blocked boolean;
  v_organization_generation bigint := 0;
  v_organization_json jsonb;
  v_organization_found boolean := false;
  v_member_generation bigint := 0;
  v_session_member_generation bigint := 0;
  v_session_organization_generation bigint := 0;
  v_gate_config jsonb;
  v_restricted boolean;
  v_has_rbac boolean;
  v_has_groups boolean;
  v_rbac_match boolean := false;
  v_group_match boolean := false;
  v_policy_operator text;
BEGIN
  -- The organisation-login-gate migration uses this lock for settings and
  -- gate-value changes. Acquire it first to retain its lock ordering.
  PERFORM public.organisation_login_gate_transaction_lock(p_tenant_id::text, false);
  PERFORM public.department_current_set_auth_lock(p_tenant_id::text, false);

  SELECT sess::jsonb, expire INTO v_session_data, v_session_expiry
    FROM public.session WHERE sid = p_session_id FOR SHARE;
  IF NOT FOUND OR v_session_data IS NULL OR v_session_expiry IS NULL
     OR v_session_expiry <= now()
     OR v_session_data->>'memberId' IS DISTINCT FROM p_member_id::text THEN
    RAISE EXCEPTION 'CURRENT_SET_AUTHORIZATION: session is expired, revoked, or not this member'
      USING ERRCODE = '42501';
  END IF;

  -- resolveFormAccess checks tenantId/preservedTenantId when an audience is
  -- restricted. Current-set is explicitly authenticated even when unrestricted;
  -- requiring its member-session provenance to be this tenant prevents an
  -- alternate-tenant session from becoming an implicit current-set authority.
  v_session_tenant_id := COALESCE(
    NULLIF(v_session_data->>'tenantId', ''),
    NULLIF(v_session_data->>'preservedTenantId', ''),
    NULLIF(v_session_data->>'memberLoginAccessTenantId', '')
  );
  IF v_session_tenant_id IS DISTINCT FROM p_tenant_id::text THEN
    RAISE EXCEPTION 'CURRENT_SET_AUTHORIZATION: session is not for this tenant'
      USING ERRCODE = '42501';
  END IF;

  -- Do not use role_id as an existence sentinel: a member may legitimately
  -- have no RBAC role and still satisfy a group-only/unrestricted audience.
  SELECT m.tenant_id::text, m.role_id, m.organization_id, m.login_enabled,
         m.membership_paused, m.email
    INTO v_member_tenant_id, v_member_role_id, v_member_organization_id,
         v_member_login_enabled, v_member_membership_paused, v_member_email
    FROM public.member m
    WHERE m.id = p_member_id
    FOR SHARE;
  v_member_found := FOUND;
  IF NOT v_member_found
     OR v_member_login_enabled IS FALSE
     OR v_member_membership_paused IS TRUE
     OR (left(COALESCE(v_member_email, ''), 8) = 'deleted_'
         AND right(COALESCE(v_member_email, ''), 14) = '@deleted.local') THEN
    RAISE EXCEPTION 'CURRENT_SET_AUTHORIZATION: member is no longer active'
      USING ERRCODE = '42501';
  END IF;

  -- getSessionMember permits a direct tenant member with no organisation.
  -- Conversely, an organisation reference must resolve in the requested
  -- tenant, even when member.tenant_id happens to be populated.
  IF v_member_organization_id IS NOT NULL THEN
    SELECT o.tenant_id::text, o.member_login_blocked,
           o.member_login_revocation_generation, to_jsonb(o)
      INTO v_organization_tenant_id, v_organization_blocked,
           v_organization_generation, v_organization_json
      FROM public.organization o
      WHERE o.id = v_member_organization_id
      FOR SHARE;
    v_organization_found := FOUND;
    IF NOT v_organization_found
       OR v_organization_tenant_id IS DISTINCT FROM p_tenant_id::text
       OR v_organization_blocked IS TRUE THEN
      RAISE EXCEPTION 'CURRENT_SET_AUTHORIZATION: member organisation is no longer active'
        USING ERRCODE = '42501';
    END IF;
  END IF;
  IF NOT COALESCE((
    v_member_tenant_id = p_tenant_id::text
    OR (v_member_tenant_id IS NULL
        AND v_organization_tenant_id = p_tenant_id::text)
  ), false) THEN
    RAISE EXCEPTION 'CURRENT_SET_AUTHORIZATION: member is not in this tenant'
      USING ERRCODE = '42501';
  END IF;

  -- This mirrors getSession's member/org fence check. A restore does not make
  -- a stale session valid because the durable generations remain advanced.
  SELECT generation INTO v_member_generation
    FROM public.member_login_session_revocation
    WHERE member_id = p_member_id::text
    FOR SHARE;
  v_member_generation := COALESCE(v_member_generation, 0);
  v_organization_generation := COALESCE(v_organization_generation, 0);
  v_session_member_generation := public.department_current_set_session_generation(
    v_session_data->>'memberLoginGeneration'
  );
  v_session_organization_generation := public.department_current_set_session_generation(
    v_session_data->>'organizationLoginGeneration'
  );
  IF v_member_generation > v_session_member_generation
     OR v_organization_generation > v_session_organization_generation THEN
    RAISE EXCEPTION 'CURRENT_SET_AUTHORIZATION: session is revoked'
      USING ERRCODE = '42501';
  END IF;

  -- evaluateMemberOrganisationLoginAccess is also part of getSession. The
  -- installed helper intentionally fails closed for an enabled malformed gate,
  -- a missing organisation, and an unresolved custom value.
  SELECT public.organisation_login_gate_config(setting_value)
    INTO v_gate_config
    FROM public.system_settings
    WHERE tenant_id::text = p_tenant_id::text
      AND setting_key = 'organization_login_gate'
    LIMIT 1;
  IF NOT public.organisation_login_gate_allows(
    v_gate_config,
    CASE WHEN v_organization_found THEN v_organization_json ELSE NULL END,
    v_member_organization_id::text
  ) THEN
    RAISE EXCEPTION 'CURRENT_SET_AUTHORIZATION: member organisation access is blocked'
      USING ERRCODE = '42501';
  END IF;

  IF p_policy IS NULL OR p_policy = '{}'::jsonb THEN RETURN; END IF;
   IF jsonb_typeof(p_policy) IS DISTINCT FROM 'object'
      OR p_policy->>'version' IS DISTINCT FROM '1'
      OR NOT COALESCE(p_policy->>'operator' IN ('and', 'or'), false)
      OR jsonb_typeof(p_policy->'rbac_role_ids') IS DISTINCT FROM 'array'
      OR jsonb_typeof(p_policy->'group_rules') IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'CURRENT_SET_AUTHORIZATION: form audience configuration is invalid'
      USING ERRCODE = '42501';
  END IF;

  -- validateFormAccessPolicy/resolveFormAccess deny the complete policy if
  -- any role, group, or configured group-role has gone stale. In particular,
  -- an OR policy must not let its other branch hide stale configuration.
  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(p_policy->'rbac_role_ids') AS supplied(role_id)
    LEFT JOIN public.role r
      ON r.tenant_id = p_tenant_id
     AND r.id::text = btrim(supplied.role_id #>> '{}')
    WHERE jsonb_typeof(supplied.role_id) <> 'string'
       OR btrim(supplied.role_id #>> '{}') = ''
       OR r.id IS NULL
  ) OR EXISTS (
    SELECT 1
    FROM jsonb_array_elements(p_policy->'group_rules') AS supplied(rule)
    LEFT JOIN public.member_group g
      ON g.tenant_id = p_tenant_id
     AND g.id::text = btrim(supplied.rule->>'group_id')
    WHERE jsonb_typeof(supplied.rule) <> 'object'
       OR jsonb_typeof(supplied.rule->'group_id') <> 'string'
       OR btrim(supplied.rule->>'group_id') = ''
       OR jsonb_typeof(supplied.rule->'role_names') <> 'array'
       OR g.id IS NULL
       OR g.is_active IS DISTINCT FROM true
       OR EXISTS (
         SELECT 1
         FROM jsonb_array_elements(supplied.rule->'role_names') AS required(role_name)
         WHERE jsonb_typeof(required.role_name) <> 'string'
            OR btrim(required.role_name #>> '{}') = ''
            OR NOT EXISTS (
              SELECT 1
              FROM jsonb_array_elements(COALESCE(to_jsonb(g.roles), '[]'::jsonb)) AS defined(role_name)
              WHERE jsonb_typeof(defined.role_name) = 'string'
                AND lower(btrim(defined.role_name #>> '{}'))
                    = lower(btrim(required.role_name #>> '{}'))
            )
       )
  ) THEN
    RAISE EXCEPTION 'CURRENT_SET_AUTHORIZATION: form audience configuration is invalid'
      USING ERRCODE = '42501';
  END IF;

  v_has_rbac := jsonb_array_length(p_policy->'rbac_role_ids') > 0;
  v_has_groups := jsonb_array_length(p_policy->'group_rules') > 0;
  v_restricted := v_has_rbac OR v_has_groups;
  IF NOT v_restricted THEN RETURN; END IF;

  v_rbac_match := EXISTS (
    SELECT 1
    FROM jsonb_array_elements(p_policy->'rbac_role_ids') AS supplied(role_id)
    WHERE v_member_role_id IS NOT NULL
      AND v_member_role_id::text = btrim(supplied.role_id #>> '{}')
  );
  SELECT EXISTS (
    SELECT 1
    FROM jsonb_array_elements(p_policy->'group_rules') AS supplied(rule)
    JOIN public.member_group g
      ON g.tenant_id = p_tenant_id
     AND g.id::text = btrim(supplied.rule->>'group_id')
     AND g.is_active = true
    JOIN public.member_group_assignment assignment
      ON assignment.tenant_id = p_tenant_id
     AND assignment.group_id = g.id
     AND assignment.member_id = p_member_id
     AND (assignment.expires_at IS NULL OR assignment.expires_at > now())
    WHERE EXISTS (
      SELECT 1 FROM jsonb_array_elements(COALESCE(to_jsonb(g.roles), '[]'::jsonb)) AS defined(role_name)
      WHERE jsonb_typeof(defined.role_name) = 'string'
        AND lower(btrim(defined.role_name #>> '{}'))
            = lower(btrim(assignment.group_role))
    )
      AND (
        jsonb_array_length(supplied.rule->'role_names') = 0
        OR EXISTS (
          SELECT 1
          FROM jsonb_array_elements(supplied.rule->'role_names') AS required(role_name)
          WHERE lower(btrim(required.role_name #>> '{}'))
              = lower(btrim(assignment.group_role))
        )
      )
  ) INTO v_group_match;

  v_policy_operator := p_policy->>'operator';
  IF NOT COALESCE(
    CASE v_policy_operator
      WHEN 'and' THEN ((NOT v_has_rbac OR v_rbac_match)
                       AND (NOT v_has_groups OR v_group_match))
      WHEN 'or' THEN ((v_has_rbac AND v_rbac_match)
                      OR (v_has_groups AND v_group_match))
      ELSE false
    END,
    false
  ) THEN
    RAISE EXCEPTION 'CURRENT_SET_AUTHORIZATION: form audience access was revoked'
      USING ERRCODE = '42501';
  END IF;
END;
$$;

-- Do not leave the former seven-argument wrapper callable: it did not bind
-- the server-validated complete answer object to the row the core RPC reads.
DROP FUNCTION IF EXISTS public.department_current_set_reconcile_authenticated(
  uuid, uuid, uuid, uuid, uuid, text, text
);

CREATE OR REPLACE FUNCTION public.department_current_set_reconcile_authenticated(
  p_tenant_id uuid, p_form_id uuid, p_department_id uuid, p_member_id uuid,
  p_submission_id uuid, p_expected_version text, p_session_id text,
  p_validated_values jsonb
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_policy jsonb;
BEGIN
  PERFORM public.department_current_set_lock(p_tenant_id);
  SELECT access_policy INTO v_policy
    FROM public.form
    WHERE tenant_id = p_tenant_id AND id = p_form_id AND is_active = true
      AND require_authentication = true
      AND (deactivate_at IS NULL OR deactivate_at > now())
    FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'CURRENT_SET_AUTHORIZATION: form is unavailable' USING ERRCODE = '42501';
  END IF;
  -- The JavaScript layer validates the complete persisted answer object before
  -- it requests this wrapper. Lock and compare the exact durable value before
  -- the core function rereads it, so a concurrent amendment cannot turn a
  -- validated request into a mutation of different answers.
  PERFORM 1
    FROM public.form_submission
    WHERE id = p_submission_id
      AND tenant_id = p_tenant_id
      AND form_id = p_form_id
      AND submission_data IS NOT DISTINCT FROM p_validated_values
    FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'CURRENT_SET_CONFLICT: persisted submission changed after validation'
      USING ERRCODE = '40001';
  END IF;
  PERFORM public.department_current_set_assert_live_actor(
    p_tenant_id, p_member_id, p_session_id, v_policy
  );
  RETURN public.department_current_set_reconcile(
    p_tenant_id, p_form_id, p_department_id, p_member_id, p_submission_id, p_expected_version
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.department_current_set_load_authenticated(
  p_tenant_id uuid, p_form_id uuid, p_department_id uuid, p_member_id uuid, p_session_id text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_policy jsonb;
BEGIN
  PERFORM public.department_current_set_lock(p_tenant_id);
  SELECT access_policy INTO v_policy
    FROM public.form
    WHERE tenant_id = p_tenant_id AND id = p_form_id AND is_active = true
      AND require_authentication = true
      AND (deactivate_at IS NULL OR deactivate_at > now())
    FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'CURRENT_SET_AUTHORIZATION: form is unavailable' USING ERRCODE = '42501';
  END IF;
  PERFORM public.department_current_set_assert_live_actor(
    p_tenant_id, p_member_id, p_session_id, v_policy
  );
  RETURN public.department_current_set_load(p_tenant_id, p_form_id, p_department_id, p_member_id);
END;
$$;

-- A missing revocation-fence row, group assignment, role, or group cannot be
-- protected by SELECT ... FOR SHARE. Every write to an input used above takes
-- the configured tenant's exclusive auth lock, while the wrapper takes shared.
-- This also makes an access revocation serialize before the current-set commit.
CREATE OR REPLACE FUNCTION public.department_current_set_auth_lock_write()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_old_tenant text;
  v_new_tenant text;
  v_old_org_tenant text;
  v_new_org_tenant text;
  v_member_id text;
  v_lock_tenant text;
BEGIN
  IF TG_OP <> 'INSERT' THEN v_old_tenant := OLD.tenant_id::text; END IF;
  IF TG_OP <> 'DELETE' THEN v_new_tenant := NEW.tenant_id::text; END IF;

  IF TG_TABLE_NAME = 'member' THEN
    IF TG_OP <> 'INSERT' AND OLD.organization_id IS NOT NULL THEN
      SELECT tenant_id::text INTO v_old_org_tenant
        FROM public.organization WHERE id = OLD.organization_id;
    END IF;
    IF TG_OP <> 'DELETE' AND NEW.organization_id IS NOT NULL THEN
      SELECT tenant_id::text INTO v_new_org_tenant
        FROM public.organization WHERE id = NEW.organization_id;
    END IF;
  ELSIF TG_TABLE_NAME = 'member_login_session_revocation' THEN
    v_member_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.member_id ELSE NEW.member_id END;
    IF v_old_tenant IS NULL AND v_new_tenant IS NULL AND v_member_id IS NOT NULL THEN
      SELECT COALESCE(m.tenant_id::text, o.tenant_id::text)
        INTO v_new_org_tenant
        FROM public.member m
        LEFT JOIN public.organization o ON o.id = m.organization_id
        WHERE m.id::text = v_member_id;
    END IF;
  END IF;

  FOR v_lock_tenant IN
    SELECT DISTINCT tenant_id
    FROM unnest(ARRAY[v_old_tenant, v_new_tenant, v_old_org_tenant, v_new_org_tenant])
      AS tenants(tenant_id)
    WHERE tenant_id IS NOT NULL AND btrim(tenant_id) <> ''
    ORDER BY tenant_id
  LOOP
    PERFORM public.department_current_set_auth_lock(v_lock_tenant, true);
  END LOOP;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.department_current_set_auth_lock_organization_write()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_old_tenant text;
  v_new_tenant text;
  v_lock_tenant text;
BEGIN
  v_old_tenant := OLD.tenant_id::text;
  v_new_tenant := NEW.tenant_id::text;
  FOR v_lock_tenant IN
    SELECT DISTINCT tenant_id
    FROM unnest(ARRAY[v_old_tenant, v_new_tenant]) AS tenants(tenant_id)
    WHERE tenant_id IS NOT NULL AND btrim(tenant_id) <> ''
    ORDER BY tenant_id
  LOOP
    PERFORM public.department_current_set_auth_lock(v_lock_tenant, true);
  END LOOP;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS department_current_set_auth_member_write_lock ON public.member;
CREATE TRIGGER department_current_set_auth_member_write_lock
BEFORE INSERT OR UPDATE OR DELETE ON public.member
FOR EACH ROW EXECUTE FUNCTION public.department_current_set_auth_lock_write();

DROP TRIGGER IF EXISTS department_current_set_auth_group_write_lock ON public.member_group;
CREATE TRIGGER department_current_set_auth_group_write_lock
BEFORE INSERT OR UPDATE OR DELETE ON public.member_group
FOR EACH ROW EXECUTE FUNCTION public.department_current_set_auth_lock_write();

DROP TRIGGER IF EXISTS department_current_set_auth_assignment_write_lock ON public.member_group_assignment;
CREATE TRIGGER department_current_set_auth_assignment_write_lock
BEFORE INSERT OR UPDATE OR DELETE ON public.member_group_assignment
FOR EACH ROW EXECUTE FUNCTION public.department_current_set_auth_lock_write();

DROP TRIGGER IF EXISTS department_current_set_auth_role_write_lock ON public.role;
CREATE TRIGGER department_current_set_auth_role_write_lock
BEFORE INSERT OR UPDATE OR DELETE ON public.role
FOR EACH ROW EXECUTE FUNCTION public.department_current_set_auth_lock_write();

DROP TRIGGER IF EXISTS department_current_set_auth_revocation_write_lock ON public.member_login_session_revocation;
CREATE TRIGGER department_current_set_auth_revocation_write_lock
BEFORE INSERT OR UPDATE OR DELETE ON public.member_login_session_revocation
FOR EACH ROW EXECUTE FUNCTION public.department_current_set_auth_lock_write();

DROP TRIGGER IF EXISTS department_current_set_auth_organization_fence_lock ON public.organization;
CREATE TRIGGER department_current_set_auth_organization_fence_lock
BEFORE UPDATE OF tenant_id, member_login_blocked, member_login_revocation_generation
ON public.organization
FOR EACH ROW EXECUTE FUNCTION public.department_current_set_auth_lock_organization_write();

REVOKE ALL ON FUNCTION public.department_current_set_auth_lock(text, boolean)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.department_current_set_session_generation(text)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.department_current_set_assert_live_actor(uuid, uuid, text, jsonb)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.department_current_set_auth_lock_write()
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.department_current_set_auth_lock_organization_write()
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.department_current_set_reconcile_authenticated(uuid, uuid, uuid, uuid, uuid, text, text, jsonb)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.department_current_set_load_authenticated(uuid, uuid, uuid, uuid, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.department_current_set_reconcile_authenticated(uuid, uuid, uuid, uuid, uuid, text, text, jsonb)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.department_current_set_load_authenticated(uuid, uuid, uuid, uuid, text)
  TO service_role;

NOTIFY pgrst, 'reload schema';