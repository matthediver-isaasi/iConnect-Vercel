-- Task #4395: durable organisation member-login kill switch.
-- Apply only with scripts/apply-organization-login-kill-switch.mjs, which
-- requires DEST_DATABASE_URL and refuses the workspace SOURCE database.

ALTER TABLE public.organization
  ADD COLUMN IF NOT EXISTS member_login_blocked boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS member_login_blocked_at timestamptz NULL,
  ADD COLUMN IF NOT EXISTS member_login_blocked_by varchar NULL,
  ADD COLUMN IF NOT EXISTS member_login_revocation_generation bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS member_login_revoked_at timestamptz NULL;

CREATE INDEX IF NOT EXISTS organization_member_login_blocked_tenant_idx
  ON public.organization (tenant_id, member_login_blocked)
  WHERE member_login_blocked = true;

-- A member-specific generation is retained forever (including after access is
-- restored), so a session issued before a manual block or reassignment cannot
-- reappear. This table is deliberately compact: one row per affected member,
-- not one row per session.
CREATE TABLE IF NOT EXISTS public.member_login_session_revocation (
  member_id text PRIMARY KEY,
  tenant_id text NULL,
  generation bigint NOT NULL DEFAULT 0,
  revoked_at timestamptz NOT NULL DEFAULT now()
);

-- Configured gate changes can affect every member in one tenant, including
-- members with no organisation. A tenant generation avoids a potentially huge
-- synchronous session/member scan while still fencing every old session.
CREATE TABLE IF NOT EXISTS public.organization_login_gate_generation (
  tenant_id text PRIMARY KEY,
  generation bigint NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION public.bump_organisation_login_gate_generation(p_tenant_id text)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  IF p_tenant_id IS NULL THEN RETURN; END IF;
  INSERT INTO public.organization_login_gate_generation (tenant_id, generation, updated_at)
  VALUES (p_tenant_id, 1, now())
  ON CONFLICT (tenant_id) DO UPDATE
    SET generation = public.organization_login_gate_generation.generation + 1,
        updated_at = now();
END;
$$;

CREATE OR REPLACE FUNCTION public.organisation_login_gate_matches(
  p_tenant_id text,
  p_field_source text,
  p_field_key text
) RETURNS boolean
LANGUAGE plpgsql
AS $$
DECLARE
  v_setting jsonb;
BEGIN
  SELECT setting_value::jsonb INTO v_setting
  FROM public.system_settings
  WHERE tenant_id::text = p_tenant_id
    AND setting_key = 'organization_login_gate'
  LIMIT 1;
  RETURN COALESCE((v_setting->>'enabled')::boolean, false)
    AND v_setting->>'fieldSource' = p_field_source
    AND v_setting->>'fieldKey' = p_field_key;
EXCEPTION WHEN OTHERS THEN
  -- Invalid configuration is enforced fail-closed by application validation;
  -- a bad setting must not make database writes fail.
  RETURN false;
END;
$$;

CREATE OR REPLACE FUNCTION public.revoke_organisation_member_login_sessions()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.member_login_blocked IS TRUE
     AND OLD.member_login_blocked IS DISTINCT FROM NEW.member_login_blocked THEN
    NEW.member_login_revocation_generation := COALESCE(OLD.member_login_revocation_generation, 0) + 1;
    NEW.member_login_revoked_at := now();
    INSERT INTO public.member_login_session_revocation (member_id, tenant_id, generation, revoked_at)
    SELECT m.id::text, NEW.tenant_id::text, 1, now()
    FROM public.member m
    WHERE m.organization_id = NEW.id
      AND (m.tenant_id IS NULL OR m.tenant_id = NEW.tenant_id)
    ON CONFLICT (member_id) DO UPDATE
      SET tenant_id = EXCLUDED.tenant_id,
          generation = public.member_login_session_revocation.generation + 1,
          revoked_at = now();
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS organization_member_login_revoke_trigger ON public.organization;
CREATE TRIGGER organization_member_login_revoke_trigger
BEFORE UPDATE OF member_login_blocked ON public.organization
FOR EACH ROW EXECUTE FUNCTION public.revoke_organisation_member_login_sessions();

CREATE OR REPLACE FUNCTION public.bump_gate_generation_for_setting()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_new_key text;
  v_old_key text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_old_key := OLD.setting_key;
  ELSE
    v_new_key := NEW.setting_key;
    IF TG_OP = 'UPDATE' THEN v_old_key := OLD.setting_key; END IF;
  END IF;
  IF v_old_key = 'organization_login_gate' THEN
    PERFORM public.bump_organisation_login_gate_generation(OLD.tenant_id::text);
  END IF;
  IF v_new_key = 'organization_login_gate' THEN
    PERFORM public.bump_organisation_login_gate_generation(NEW.tenant_id::text);
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS organization_login_gate_setting_generation_trigger ON public.system_settings;
CREATE TRIGGER organization_login_gate_setting_generation_trigger
AFTER INSERT OR UPDATE OR DELETE ON public.system_settings
FOR EACH ROW EXECUTE FUNCTION public.bump_gate_generation_for_setting();

CREATE OR REPLACE FUNCTION public.organisation_login_gate_core_changed(
  p_tenant_id text,
  p_old jsonb,
  p_new jsonb
) RETURNS boolean
LANGUAGE plpgsql
AS $$
DECLARE
  v_setting jsonb;
  v_field_key text;
BEGIN
  SELECT setting_value::jsonb INTO v_setting
  FROM public.system_settings
  WHERE tenant_id::text = p_tenant_id
    AND setting_key = 'organization_login_gate'
  LIMIT 1;
  IF NOT COALESCE((v_setting->>'enabled')::boolean, false)
     OR v_setting->>'fieldSource' <> 'core' THEN
    RETURN false;
  END IF;
  v_field_key := v_setting->>'fieldKey';
  RETURN v_field_key IN ('is_active', 'status', 'country')
    AND (p_old->>v_field_key) IS DISTINCT FROM (p_new->>v_field_key);
EXCEPTION WHEN OTHERS THEN
  RETURN false;
END;
$$;

CREATE OR REPLACE FUNCTION public.bump_gate_generation_for_organization()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.tenant_id IS DISTINCT FROM NEW.tenant_id THEN
    PERFORM public.bump_organisation_login_gate_generation(OLD.tenant_id::text);
    PERFORM public.bump_organisation_login_gate_generation(NEW.tenant_id::text);
  ELSIF public.organisation_login_gate_core_changed(
    NEW.tenant_id::text, to_jsonb(OLD), to_jsonb(NEW)
  ) THEN
    PERFORM public.bump_organisation_login_gate_generation(NEW.tenant_id::text);
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS organization_login_gate_core_generation_trigger ON public.organization;
CREATE TRIGGER organization_login_gate_core_generation_trigger
AFTER UPDATE ON public.organization
FOR EACH ROW EXECUTE FUNCTION public.bump_gate_generation_for_organization();

CREATE OR REPLACE FUNCTION public.bump_gate_generation_for_organization_preference()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_new_org_id text;
  v_old_org_id text;
  v_new_field_id text;
  v_old_field_id text;
  v_new_tenant_id text;
  v_old_tenant_id text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_old_org_id := OLD.organization_id::text;
    v_old_field_id := OLD.field_id::text;
  ELSE
    v_new_org_id := NEW.organization_id::text;
    v_new_field_id := NEW.field_id::text;
    IF TG_OP = 'UPDATE' THEN
      v_old_org_id := OLD.organization_id::text;
      v_old_field_id := OLD.field_id::text;
    END IF;
  END IF;
  IF v_old_org_id IS NOT NULL THEN
    SELECT tenant_id::text INTO v_old_tenant_id FROM public.organization WHERE id::text = v_old_org_id;
    IF public.organisation_login_gate_matches(v_old_tenant_id, 'custom', v_old_field_id)
       OR public.organisation_login_gate_matches(v_old_tenant_id, 'custom', v_new_field_id) THEN
      PERFORM public.bump_organisation_login_gate_generation(v_old_tenant_id);
    END IF;
  END IF;
  IF v_new_org_id IS NOT NULL THEN
    SELECT tenant_id::text INTO v_new_tenant_id FROM public.organization WHERE id::text = v_new_org_id;
    IF v_new_tenant_id IS DISTINCT FROM v_old_tenant_id
       AND (public.organisation_login_gate_matches(v_new_tenant_id, 'custom', v_new_field_id)
         OR public.organisation_login_gate_matches(v_new_tenant_id, 'custom', v_old_field_id)) THEN
      PERFORM public.bump_organisation_login_gate_generation(v_new_tenant_id);
    END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS organization_login_gate_preference_generation_trigger ON public.organization_preference_value;
CREATE TRIGGER organization_login_gate_preference_generation_trigger
AFTER INSERT OR UPDATE OR DELETE ON public.organization_preference_value
FOR EACH ROW EXECUTE FUNCTION public.bump_gate_generation_for_organization_preference();

CREATE OR REPLACE FUNCTION public.revoke_member_session_on_organisation_reassignment()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_tenant_id text;
BEGIN
  IF OLD.organization_id IS DISTINCT FROM NEW.organization_id
     OR OLD.tenant_id IS DISTINCT FROM NEW.tenant_id THEN
    v_tenant_id := COALESCE(NEW.tenant_id, OLD.tenant_id)::text;
    INSERT INTO public.member_login_session_revocation (member_id, tenant_id, generation, revoked_at)
    VALUES (NEW.id::text, v_tenant_id, 1, now())
    ON CONFLICT (member_id) DO UPDATE
      SET tenant_id = EXCLUDED.tenant_id,
          generation = public.member_login_session_revocation.generation + 1,
          revoked_at = now();
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS member_login_reassignment_revoke_trigger ON public.member;
CREATE TRIGGER member_login_reassignment_revoke_trigger
AFTER UPDATE OF organization_id, tenant_id ON public.member
FOR EACH ROW EXECUTE FUNCTION public.revoke_member_session_on_organisation_reassignment();

-- The application stamps every member-derived cookie/bearer session with both
-- generations. This database write fence closes the final read/check/insert
-- race: a stale issuer cannot commit a session after a concurrent block, gate
-- change, or reassignment has advanced its durable generation.
CREATE OR REPLACE FUNCTION public.fence_member_login_session_write()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_member_id text;
  v_tenant_id text;
  v_member_generation bigint := 0;
  v_gate_generation bigint := 0;
  v_stamped_member_generation bigint := 0;
  v_stamped_gate_generation bigint := 0;
BEGIN
  v_member_id := NEW.sess->>'memberId';
  IF v_member_id IS NULL THEN RETURN NEW; END IF;
  v_tenant_id := COALESCE(NEW.sess->>'memberLoginAccessTenantId', NEW.sess->>'tenantId');
  BEGIN
    v_stamped_member_generation := COALESCE((NEW.sess->>'memberLoginGeneration')::bigint, 0);
    v_stamped_gate_generation := COALESCE((NEW.sess->>'organisationLoginGateGeneration')::bigint, 0);
  EXCEPTION WHEN invalid_text_representation THEN
    RAISE EXCEPTION 'Invalid member login session generation';
  END;
  SELECT generation INTO v_member_generation
  FROM public.member_login_session_revocation WHERE member_id = v_member_id;
  IF v_tenant_id IS NOT NULL THEN
    SELECT generation INTO v_gate_generation
    FROM public.organization_login_gate_generation WHERE tenant_id = v_tenant_id;
  END IF;
  IF COALESCE(v_member_generation, 0) > v_stamped_member_generation
     OR COALESCE(v_gate_generation, 0) > v_stamped_gate_generation THEN
    RAISE EXCEPTION 'Member login session generation is revoked';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS member_login_session_generation_fence_trigger ON public.session;
CREATE TRIGGER member_login_session_generation_fence_trigger
BEFORE INSERT OR UPDATE OF sess ON public.session
FOR EACH ROW EXECUTE FUNCTION public.fence_member_login_session_write();

-- Version 2 narrows configured-gate revocation to members whose *effective*
-- access transitions from allowed to denied. The original tenant-wide counter
-- remains only as an inert, protected historical table for installations that
-- briefly ran the first version; new sessions never consult it.
DROP TRIGGER IF EXISTS organization_login_gate_setting_generation_trigger ON public.system_settings;
DROP TRIGGER IF EXISTS organization_login_gate_core_generation_trigger ON public.organization;
DROP TRIGGER IF EXISTS organization_login_gate_preference_generation_trigger ON public.organization_preference_value;

CREATE OR REPLACE FUNCTION public.organisation_login_gate_config(p_value text)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
BEGIN
  IF p_value IS NULL OR btrim(p_value) = '' THEN RETURN NULL; END IF;
  RETURN p_value::jsonb;
EXCEPTION WHEN OTHERS THEN
  RETURN '{"enabled":true,"invalid":true}'::jsonb;
END;
$$;

CREATE OR REPLACE FUNCTION public.organisation_login_gate_custom_value_allows(
  p_config jsonb,
  p_value text
) RETURNS boolean
LANGUAGE plpgsql
AS $$
DECLARE
  v_required text := lower(btrim(COALESCE(p_config->>'requiredValue', '')));
  v_json jsonb;
BEGIN
  IF p_value IS NULL THEN RETURN false; END IF;
  BEGIN
    v_json := p_value::jsonb;
    IF jsonb_typeof(v_json) = 'array' THEN
      RETURN EXISTS (
        SELECT 1 FROM jsonb_array_elements(v_json) AS element
        WHERE lower(btrim(CASE WHEN jsonb_typeof(element) = 'object'
          THEN COALESCE(element->>'value', '') ELSE trim(both '"' FROM element::text) END)) = v_required
      );
    END IF;
    IF jsonb_typeof(v_json) = 'object' THEN
      RETURN lower(btrim(COALESCE(v_json->>'value', ''))) = v_required;
    END IF;
    RETURN lower(btrim(trim(both '"' FROM v_json::text))) = v_required;
  EXCEPTION WHEN OTHERS THEN
    RETURN lower(btrim(p_value)) = v_required;
  END;
END;
$$;

CREATE OR REPLACE FUNCTION public.organisation_login_gate_allows(
  p_config jsonb,
  p_organisation jsonb,
  p_organisation_id text
) RETURNS boolean
LANGUAGE plpgsql
AS $$
DECLARE
  v_source text;
  v_key text;
  v_required text;
  v_value text;
BEGIN
  IF p_config IS NULL OR NOT COALESCE((p_config->>'enabled')::boolean, false) THEN RETURN true; END IF;
  v_source := p_config->>'fieldSource';
  v_key := p_config->>'fieldKey';
  v_required := lower(btrim(COALESCE(p_config->>'requiredValue', '')));
  IF p_config->>'invalid' = 'true' OR v_source IS NULL OR v_key IS NULL THEN RETURN false; END IF;
  IF p_organisation IS NULL THEN RETURN false; END IF;
  IF v_source = 'core' THEN
    IF v_key NOT IN ('is_active', 'status', 'country') THEN RETURN false; END IF;
    RETURN lower(btrim(COALESCE(p_organisation->>v_key, ''))) = v_required;
  END IF;
  IF v_source = 'custom' THEN
    SELECT value INTO v_value FROM public.organization_preference_value
    WHERE organization_id::text = p_organisation_id AND field_id::text = v_key LIMIT 1;
    RETURN public.organisation_login_gate_custom_value_allows(p_config, v_value);
  END IF;
  RETURN false;
EXCEPTION WHEN OTHERS THEN
  RETURN false;
END;
$$;

CREATE OR REPLACE FUNCTION public.bump_member_login_generation(p_member_id text, p_tenant_id text)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  INSERT INTO public.member_login_session_revocation (member_id, tenant_id, generation, revoked_at)
  VALUES (p_member_id, p_tenant_id, 1, now())
  ON CONFLICT (member_id) DO UPDATE
    SET tenant_id = EXCLUDED.tenant_id,
        generation = public.member_login_session_revocation.generation + 1,
        revoked_at = now();
END;
$$;

CREATE OR REPLACE FUNCTION public.revoke_gate_members_transitioning_to_denied(
  p_tenant_id text,
  p_old_config jsonb,
  p_new_config jsonb
) RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  INSERT INTO public.member_login_session_revocation (member_id, tenant_id, generation, revoked_at)
  SELECT m.id::text, p_tenant_id, 1, now()
  FROM public.member m
  LEFT JOIN public.organization o ON o.id = m.organization_id
  WHERE m.tenant_id::text = p_tenant_id
    AND public.organisation_login_gate_allows(
      p_old_config, CASE WHEN o.id IS NULL THEN NULL ELSE to_jsonb(o) END, o.id::text
    )
    AND NOT public.organisation_login_gate_allows(
      p_new_config, CASE WHEN o.id IS NULL THEN NULL ELSE to_jsonb(o) END, o.id::text
    )
  ON CONFLICT (member_id) DO UPDATE
    SET tenant_id = EXCLUDED.tenant_id,
        generation = public.member_login_session_revocation.generation + 1,
        revoked_at = now();
END;
$$;

CREATE OR REPLACE FUNCTION public.revoke_organisation_members_for_gate_transition(
  p_tenant_id text,
  p_organisation_id text
) RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  INSERT INTO public.member_login_session_revocation (member_id, tenant_id, generation, revoked_at)
  SELECT id::text, p_tenant_id, 1, now()
  FROM public.member
  WHERE organization_id::text = p_organisation_id
    AND (tenant_id IS NULL OR tenant_id::text = p_tenant_id)
  ON CONFLICT (member_id) DO UPDATE
    SET tenant_id = EXCLUDED.tenant_id,
        generation = public.member_login_session_revocation.generation + 1,
        revoked_at = now();
END;
$$;

CREATE OR REPLACE FUNCTION public.revoke_gate_members_for_setting_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_old_config jsonb;
  v_new_config jsonb;
BEGIN
  IF TG_OP <> 'INSERT' AND OLD.setting_key = 'organization_login_gate' THEN
    v_old_config := public.organisation_login_gate_config(OLD.setting_value);
  END IF;
  IF TG_OP <> 'DELETE' AND NEW.setting_key = 'organization_login_gate' THEN
    v_new_config := public.organisation_login_gate_config(NEW.setting_value);
  END IF;
  IF v_old_config IS NOT NULL OR v_new_config IS NOT NULL THEN
    IF TG_OP <> 'DELETE' THEN
      PERFORM public.revoke_gate_members_transitioning_to_denied(NEW.tenant_id::text, v_old_config, v_new_config);
    END IF;
    IF TG_OP = 'UPDATE' AND OLD.tenant_id IS DISTINCT FROM NEW.tenant_id THEN
      PERFORM public.revoke_gate_members_transitioning_to_denied(OLD.tenant_id::text, v_old_config, NULL);
    END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER organization_login_gate_setting_generation_trigger
AFTER INSERT OR UPDATE OR DELETE ON public.system_settings
FOR EACH ROW EXECUTE FUNCTION public.revoke_gate_members_for_setting_change();

CREATE OR REPLACE FUNCTION public.revoke_gate_members_for_core_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_config jsonb;
BEGIN
  SELECT public.organisation_login_gate_config(setting_value) INTO v_config
  FROM public.system_settings WHERE tenant_id = NEW.tenant_id AND setting_key = 'organization_login_gate';
  IF public.organisation_login_gate_allows(v_config, to_jsonb(OLD), OLD.id::text)
     AND NOT public.organisation_login_gate_allows(v_config, to_jsonb(NEW), NEW.id::text) THEN
    PERFORM public.revoke_organisation_members_for_gate_transition(NEW.tenant_id::text, NEW.id::text);
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER organization_login_gate_core_generation_trigger
AFTER UPDATE ON public.organization
FOR EACH ROW EXECUTE FUNCTION public.revoke_gate_members_for_core_change();

CREATE OR REPLACE FUNCTION public.revoke_gate_members_for_custom_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_new_org_id text;
  v_old_org_id text;
  v_old_tenant_id text;
  v_new_tenant_id text;
  v_old_config jsonb;
  v_new_config jsonb;
  v_old_key text;
  v_new_key text;
  v_old_allows boolean := false;
  v_new_allows boolean := false;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    v_old_org_id := OLD.organization_id::text;
    SELECT tenant_id::text INTO v_old_tenant_id FROM public.organization WHERE id::text = v_old_org_id;
    SELECT public.organisation_login_gate_config(setting_value) INTO v_old_config
    FROM public.system_settings WHERE tenant_id::text = v_old_tenant_id AND setting_key = 'organization_login_gate';
    v_old_key := v_old_config->>'fieldKey';
    IF v_old_config->>'fieldSource' = 'custom' AND OLD.field_id::text = v_old_key THEN
      v_old_allows := public.organisation_login_gate_custom_value_allows(v_old_config, OLD.value);
      -- On a delete or a move to another organisation the old org has no
      -- replacement value. On an in-place update, inspect the new value.
      IF TG_OP = 'UPDATE' AND NEW.organization_id IS NOT DISTINCT FROM OLD.organization_id
         AND NEW.field_id::text = v_old_key THEN
        v_new_allows := public.organisation_login_gate_custom_value_allows(v_old_config, NEW.value);
      END IF;
      IF v_old_allows AND NOT v_new_allows THEN
        PERFORM public.revoke_organisation_members_for_gate_transition(v_old_tenant_id, v_old_org_id);
      END IF;
    END IF;
  END IF;

  -- A value newly introduced in a different organisation is a recovery or an
  -- unrelated field write, not an allowed-to-denied transition. It therefore
  -- must not revoke that organisation's members.
  IF TG_OP = 'INSERT' OR (TG_OP = 'UPDATE' AND NEW.organization_id IS DISTINCT FROM OLD.organization_id) THEN
    v_new_org_id := NEW.organization_id::text;
    SELECT tenant_id::text INTO v_new_tenant_id FROM public.organization WHERE id::text = v_new_org_id;
    SELECT public.organisation_login_gate_config(setting_value) INTO v_new_config
    FROM public.system_settings WHERE tenant_id::text = v_new_tenant_id AND setting_key = 'organization_login_gate';
    v_new_key := v_new_config->>'fieldKey';
    IF v_new_config->>'fieldSource' = 'custom' AND NEW.field_id::text = v_new_key THEN
      -- Explicitly compute this path for clarity; a new value cannot turn an
      -- already-valid gate value into denial.
      v_new_allows := public.organisation_login_gate_custom_value_allows(v_new_config, NEW.value);
    END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER organization_login_gate_preference_generation_trigger
AFTER INSERT OR UPDATE OR DELETE ON public.organization_preference_value
FOR EACH ROW EXECUTE FUNCTION public.revoke_gate_members_for_custom_change();

-- The session table and both ledgers are authentication infrastructure; only
-- service_role may read/write them. RLS is forced so accidental ownership does
-- not bypass the policy, while Supabase's service-role server client retains
-- its BypassRLS capability.
ALTER TABLE public.member_login_session_revocation ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.member_login_session_revocation FORCE ROW LEVEL SECURITY;
ALTER TABLE public.organization_login_gate_generation ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.organization_login_gate_generation FORCE ROW LEVEL SECURITY;
ALTER TABLE public.session ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.session FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.member_login_session_revocation FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.organization_login_gate_generation FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.session FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.bump_organisation_login_gate_generation(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.organisation_login_gate_matches(text, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.revoke_organisation_member_login_sessions() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.bump_gate_generation_for_setting() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.organisation_login_gate_core_changed(text, jsonb, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.bump_gate_generation_for_organization() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.bump_gate_generation_for_organization_preference() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.revoke_member_session_on_organisation_reassignment() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fence_member_login_session_write() FROM PUBLIC, anon, authenticated;

-- Every policy input write participates in the same tenant advisory-lock
-- protocol as a gate-config change. Without this, a config write and a core
--/custom value write can each evaluate the other's old state (write skew).
CREATE OR REPLACE FUNCTION public.lock_organisation_login_gate_policy_write()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_old_tenant text;
  v_new_tenant text;
  v_lock_tenant text;
BEGIN
  IF TG_TABLE_NAME = 'organization' THEN
    IF TG_OP <> 'INSERT' THEN v_old_tenant := OLD.tenant_id::text; END IF;
    IF TG_OP <> 'DELETE' THEN v_new_tenant := NEW.tenant_id::text; END IF;
  ELSE
    IF TG_OP <> 'INSERT' THEN
      SELECT tenant_id::text INTO v_old_tenant FROM public.organization WHERE id = OLD.organization_id;
    END IF;
    IF TG_OP <> 'DELETE' THEN
      SELECT tenant_id::text INTO v_new_tenant FROM public.organization WHERE id = NEW.organization_id;
    END IF;
  END IF;
  -- Lock every distinct tenant in lexical order. This covers both directions
  -- of a cross-tenant preference move and prevents inverse-order deadlocks.
  FOR v_lock_tenant IN
    SELECT DISTINCT tenant_id
    FROM unnest(ARRAY[v_old_tenant, v_new_tenant]) AS tenant_id
    WHERE tenant_id IS NOT NULL
    ORDER BY tenant_id
  LOOP
    PERFORM public.organisation_login_gate_transaction_lock(v_lock_tenant, false);
  END LOOP;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS organization_login_gate_policy_write_lock_trigger ON public.organization;
CREATE TRIGGER organization_login_gate_policy_write_lock_trigger
BEFORE UPDATE ON public.organization
FOR EACH ROW EXECUTE FUNCTION public.lock_organisation_login_gate_policy_write();
DROP TRIGGER IF EXISTS organization_preference_login_gate_policy_write_lock_trigger ON public.organization_preference_value;
CREATE TRIGGER organization_preference_login_gate_policy_write_lock_trigger
BEFORE INSERT OR UPDATE OR DELETE ON public.organization_preference_value
FOR EACH ROW EXECUTE FUNCTION public.lock_organisation_login_gate_policy_write();
REVOKE ALL ON FUNCTION public.lock_organisation_login_gate_policy_write() FROM PUBLIC, anon, authenticated;

-- Reassert after the backwards-compatible v1/v2 definitions above: this is
-- the authoritative session fence used by the trigger.
CREATE OR REPLACE FUNCTION public.fence_member_login_session_write()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_member_id text;
  v_tenant_id text;
  v_member_generation bigint := 0;
  v_organization_generation bigint := 0;
  v_stamped_member_generation bigint := 0;
  v_stamped_organization_generation bigint := 0;
  v_config jsonb;
  v_organization jsonb;
  v_organization_id text;
  v_old_member_generation bigint := 0;
  v_old_organization_generation bigint := 0;
BEGIN
  v_member_id := NEW.sess->>'memberId';
  IF v_member_id IS NULL THEN RETURN NEW; END IF;
  v_tenant_id := COALESCE(NEW.sess->>'memberLoginAccessTenantId', NEW.sess->>'tenantId');
  PERFORM public.organisation_login_gate_transaction_lock(v_tenant_id, false);
  IF TG_OP = 'UPDATE' AND OLD.sess->>'memberId' IS NOT NULL THEN
    SELECT r.generation, o.member_login_revocation_generation
    INTO v_old_member_generation, v_old_organization_generation
    FROM public.member m
    LEFT JOIN public.member_login_session_revocation r ON r.member_id = m.id::text
    LEFT JOIN public.organization o ON o.id = m.organization_id
    WHERE m.id::text = OLD.sess->>'memberId';
    IF COALESCE(v_old_member_generation, 0) > COALESCE((OLD.sess->>'memberLoginGeneration')::bigint, 0)
       OR COALESCE(v_old_organization_generation, 0) > COALESCE((OLD.sess->>'organizationLoginGeneration')::bigint, 0) THEN
      RAISE EXCEPTION 'Existing member login session generation is revoked';
    END IF;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.sess->>'memberId' IS NOT NULL THEN
    SELECT r.generation, o.member_login_revocation_generation
    INTO v_old_member_generation, v_old_organization_generation
    FROM public.member m
    LEFT JOIN public.member_login_session_revocation r ON r.member_id = m.id::text
    LEFT JOIN public.organization o ON o.id = m.organization_id
    WHERE m.id::text = OLD.sess->>'memberId';
    IF COALESCE(v_old_member_generation, 0)
         > COALESCE((OLD.sess->>'memberLoginGeneration')::bigint, 0)
       OR COALESCE(v_old_organization_generation, 0)
         > COALESCE((OLD.sess->>'organizationLoginGeneration')::bigint, 0) THEN
      RAISE EXCEPTION 'Existing member login session generation is revoked';
    END IF;
  END IF;
  BEGIN
    v_stamped_member_generation := COALESCE((NEW.sess->>'memberLoginGeneration')::bigint, 0);
    v_stamped_organization_generation := COALESCE((NEW.sess->>'organizationLoginGeneration')::bigint, 0);
  EXCEPTION WHEN invalid_text_representation THEN
    RAISE EXCEPTION 'Invalid member login session generation';
  END;
  SELECT r.generation, o.member_login_revocation_generation, to_jsonb(o), o.id::text
  INTO v_member_generation, v_organization_generation, v_organization, v_organization_id
  FROM public.member m
  LEFT JOIN public.member_login_session_revocation r ON r.member_id = m.id::text
  LEFT JOIN public.organization o ON o.id = m.organization_id
  WHERE m.id::text = v_member_id;
  SELECT public.organisation_login_gate_config(setting_value) INTO v_config
  FROM public.system_settings WHERE tenant_id::text = v_tenant_id AND setting_key = 'organization_login_gate';
  IF NOT public.organisation_login_gate_allows(v_config, v_organization, v_organization_id) THEN
    RAISE EXCEPTION 'Member login session is blocked by organisation gate';
  END IF;
  IF COALESCE(v_member_generation, 0) > v_stamped_member_generation
     OR COALESCE(v_organization_generation, 0) > v_stamped_organization_generation THEN
    RAISE EXCEPTION 'Member login session generation is revoked';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.fence_member_login_session_write() FROM PUBLIC, anon, authenticated;

ALTER TABLE public.organization
  DROP CONSTRAINT IF EXISTS organization_member_login_revocation_generation_nonnegative;
ALTER TABLE public.organization
  ADD CONSTRAINT organization_member_login_revocation_generation_nonnegative
  CHECK (member_login_revocation_generation >= 0);

CREATE OR REPLACE FUNCTION public.enforce_member_login_revocation_generation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.member_login_revocation_generation < OLD.member_login_revocation_generation THEN
    RAISE EXCEPTION 'member_login_revocation_generation must be monotonic';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS organization_member_login_generation_monotonic_trigger ON public.organization;
CREATE TRIGGER organization_member_login_generation_monotonic_trigger
BEFORE UPDATE OF member_login_revocation_generation ON public.organization
FOR EACH ROW EXECUTE FUNCTION public.enforce_member_login_revocation_generation();

CREATE OR REPLACE FUNCTION public.organisation_login_gate_transaction_lock(p_tenant_id text, p_exclusive boolean)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  IF p_tenant_id IS NULL THEN RETURN; END IF;
  IF p_exclusive THEN
    PERFORM pg_advisory_xact_lock(hashtext('organisation-login-gate:' || p_tenant_id));
  ELSE
    PERFORM pg_advisory_xact_lock_shared(hashtext('organisation-login-gate:' || p_tenant_id));
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.lock_organisation_login_gate_setting_transition()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.setting_key = 'organization_login_gate' THEN
      PERFORM public.organisation_login_gate_transaction_lock(OLD.tenant_id::text, true);
    END IF;
    RETURN OLD;
  END IF;
  IF NEW.setting_key = 'organization_login_gate'
     OR (TG_OP = 'UPDATE' AND OLD.setting_key = 'organization_login_gate') THEN
    PERFORM public.organisation_login_gate_transaction_lock(NEW.tenant_id::text, true);
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS organization_login_gate_setting_lock_trigger ON public.system_settings;
CREATE TRIGGER organization_login_gate_setting_lock_trigger
BEFORE INSERT OR UPDATE OR DELETE ON public.system_settings
FOR EACH ROW EXECUTE FUNCTION public.lock_organisation_login_gate_setting_transition();

CREATE OR REPLACE FUNCTION public.lock_organisation_login_gate_member_or_org_create()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE v_tenant_id text;
BEGIN
  IF TG_TABLE_NAME = 'organization' THEN
    v_tenant_id := NEW.tenant_id::text;
  ELSE
    v_tenant_id := NEW.tenant_id::text;
    IF v_tenant_id IS NULL AND NEW.organization_id IS NOT NULL THEN
      SELECT tenant_id::text INTO v_tenant_id FROM public.organization WHERE id = NEW.organization_id;
    END IF;
  END IF;
  PERFORM public.organisation_login_gate_transaction_lock(v_tenant_id, false);
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS organization_login_gate_organization_create_lock_trigger ON public.organization;
CREATE TRIGGER organization_login_gate_organization_create_lock_trigger
BEFORE INSERT ON public.organization
FOR EACH ROW EXECUTE FUNCTION public.lock_organisation_login_gate_member_or_org_create();
DROP TRIGGER IF EXISTS organization_login_gate_member_create_lock_trigger ON public.member;
CREATE TRIGGER organization_login_gate_member_create_lock_trigger
BEFORE INSERT ON public.member
FOR EACH ROW EXECUTE FUNCTION public.lock_organisation_login_gate_member_or_org_create();

CREATE OR REPLACE FUNCTION public.fence_member_login_session_write()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_member_id text;
  v_tenant_id text;
  v_member_generation bigint := 0;
  v_organization_generation bigint := 0;
  v_stamped_member_generation bigint := 0;
  v_stamped_organization_generation bigint := 0;
  v_config jsonb;
  v_organization jsonb;
  v_organization_id text;
BEGIN
  v_member_id := NEW.sess->>'memberId';
  IF v_member_id IS NULL THEN RETURN NEW; END IF;
  v_tenant_id := COALESCE(NEW.sess->>'memberLoginAccessTenantId', NEW.sess->>'tenantId');
  PERFORM public.organisation_login_gate_transaction_lock(v_tenant_id, false);
  BEGIN
    v_stamped_member_generation := COALESCE((NEW.sess->>'memberLoginGeneration')::bigint, 0);
    v_stamped_organization_generation := COALESCE((NEW.sess->>'organizationLoginGeneration')::bigint, 0);
  EXCEPTION WHEN invalid_text_representation THEN
    RAISE EXCEPTION 'Invalid member login session generation';
  END;
  SELECT r.generation, o.member_login_revocation_generation, to_jsonb(o), o.id::text
  INTO v_member_generation, v_organization_generation, v_organization, v_organization_id
  FROM public.member m
  LEFT JOIN public.member_login_session_revocation r ON r.member_id = m.id::text
  LEFT JOIN public.organization o ON o.id = m.organization_id
  WHERE m.id::text = v_member_id;
  SELECT public.organisation_login_gate_config(setting_value) INTO v_config
  FROM public.system_settings WHERE tenant_id::text = v_tenant_id AND setting_key = 'organization_login_gate';
  IF NOT public.organisation_login_gate_allows(v_config, v_organization, v_organization_id) THEN
    RAISE EXCEPTION 'Member login session is blocked by organisation gate';
  END IF;
  IF COALESCE(v_member_generation, 0) > v_stamped_member_generation
     OR COALESCE(v_organization_generation, 0) > v_stamped_organization_generation THEN
    RAISE EXCEPTION 'Member login session generation is revoked';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.enforce_member_login_revocation_generation() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.organisation_login_gate_transaction_lock(text, boolean) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.lock_organisation_login_gate_setting_transition() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.lock_organisation_login_gate_member_or_org_create() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fence_member_login_session_write() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.organisation_login_gate_config(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.organisation_login_gate_custom_value_allows(jsonb, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.organisation_login_gate_allows(jsonb, jsonb, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.bump_member_login_generation(text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.revoke_gate_members_transitioning_to_denied(text, jsonb, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.revoke_organisation_members_for_gate_transition(text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.revoke_gate_members_for_setting_change() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.revoke_gate_members_for_core_change() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.revoke_gate_members_for_custom_change() FROM PUBLIC, anon, authenticated;

-- Organisation generations fence members inserted after a block/gate
-- transaction has taken its initial member snapshot. They are deliberately
-- per-organisation, so an edit to A cannot invalidate B.
CREATE OR REPLACE FUNCTION public.revoke_organisation_members_for_gate_transition(
  p_tenant_id text,
  p_organisation_id text
) RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  UPDATE public.organization
  SET member_login_revocation_generation = COALESCE(member_login_revocation_generation, 0) + 1,
      member_login_revoked_at = now()
  WHERE id::text = p_organisation_id AND tenant_id::text = p_tenant_id;

  INSERT INTO public.member_login_session_revocation (member_id, tenant_id, generation, revoked_at)
  SELECT id::text, p_tenant_id, 1, now()
  FROM public.member
  WHERE organization_id::text = p_organisation_id
    AND (tenant_id IS NULL OR tenant_id::text = p_tenant_id)
  ON CONFLICT (member_id) DO UPDATE
    SET tenant_id = EXCLUDED.tenant_id,
        generation = public.member_login_session_revocation.generation + 1,
        revoked_at = now();
END;
$$;

CREATE OR REPLACE FUNCTION public.revoke_gate_members_transitioning_to_denied(
  p_tenant_id text,
  p_old_config jsonb,
  p_new_config jsonb
) RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  -- Fence every affected organisation before scanning its members. This also
  -- covers a member inserted concurrently after this statement begins.
  UPDATE public.organization o
  SET member_login_revocation_generation = COALESCE(o.member_login_revocation_generation, 0) + 1,
      member_login_revoked_at = now()
  WHERE o.tenant_id::text = p_tenant_id
    AND public.organisation_login_gate_allows(p_old_config, to_jsonb(o), o.id::text)
    AND NOT public.organisation_login_gate_allows(p_new_config, to_jsonb(o), o.id::text);

  INSERT INTO public.member_login_session_revocation (member_id, tenant_id, generation, revoked_at)
  SELECT m.id::text, p_tenant_id, 1, now()
  FROM public.member m
  LEFT JOIN public.organization o ON o.id = m.organization_id
  WHERE (m.tenant_id::text = p_tenant_id
         OR (m.tenant_id IS NULL AND o.tenant_id::text = p_tenant_id))
    AND public.organisation_login_gate_allows(
      p_old_config, CASE WHEN o.id IS NULL THEN NULL ELSE to_jsonb(o) END, o.id::text
    )
    AND NOT public.organisation_login_gate_allows(
      p_new_config, CASE WHEN o.id IS NULL THEN NULL ELSE to_jsonb(o) END, o.id::text
    )
  ON CONFLICT (member_id) DO UPDATE
    SET tenant_id = EXCLUDED.tenant_id,
        generation = public.member_login_session_revocation.generation + 1,
        revoked_at = now();
END;
$$;

-- (The final session-fence definition appears above its supporting v2 helper
-- declarations; re-create it here only after every helper is in place.)
CREATE OR REPLACE FUNCTION public.guard_existing_member_session_lineage()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE v_member_generation bigint := 0; v_org_generation bigint := 0;
BEGIN
  IF OLD.sess->>'memberId' IS NULL THEN RETURN NEW; END IF;
  SELECT r.generation, o.member_login_revocation_generation INTO v_member_generation, v_org_generation
  FROM public.member m
  LEFT JOIN public.member_login_session_revocation r ON r.member_id = m.id::text
  LEFT JOIN public.organization o ON o.id = m.organization_id
  WHERE m.id::text = OLD.sess->>'memberId';
  IF COALESCE(v_member_generation, 0) > COALESCE((OLD.sess->>'memberLoginGeneration')::bigint, 0)
     OR COALESCE(v_org_generation, 0) > COALESCE((OLD.sess->>'organizationLoginGeneration')::bigint, 0) THEN
    RAISE EXCEPTION 'Existing member login session generation is revoked';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS guard_existing_member_session_lineage_trigger ON public.session;
CREATE TRIGGER guard_existing_member_session_lineage_trigger
BEFORE UPDATE OF sess ON public.session
FOR EACH ROW EXECUTE FUNCTION public.guard_existing_member_session_lineage();
REVOKE ALL ON FUNCTION public.guard_existing_member_session_lineage() FROM PUBLIC, anon, authenticated;