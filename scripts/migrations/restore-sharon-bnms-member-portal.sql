-- Restore Sharon Bacon's BNMS member-portal access after the approved
-- all-member cleanup.
--
-- SAFETY:
--   * This script is pinned to one tenant, identity, membership, email, and
--     newly allocated Member UUID.
--   * The first run is permitted only while BNMS has zero Members.
--   * An exact already-applied state is accepted as an idempotent no-op.
--   * No identity, password credential, tenant membership, tenant user,
--     organisation, or historical Member data is created.
--   * The script rolls back by default. Review every result set, then replace
--     the final ROLLBACK with exactly COMMIT and run the whole file once.

BEGIN;

SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '60s';

LOCK TABLE
  public.tenant,
  public.tenant_identity,
  public.tenant_membership,
  public.tenant_membership_credentials,
  public.tenant_user,
  public.member,
  public.organization
IN SHARE ROW EXCLUSIVE MODE;

CREATE TEMP TABLE _sharon_bnms_scope (
  tenant_id uuid PRIMARY KEY,
  tenant_slug text NOT NULL,
  identity_id text NOT NULL,
  membership_id text NOT NULL,
  member_id uuid NOT NULL,
  email text NOT NULL,
  first_name text NOT NULL,
  last_name text NOT NULL
) ON COMMIT DROP;

INSERT INTO _sharon_bnms_scope (
  tenant_id,
  tenant_slug,
  identity_id,
  membership_id,
  member_id,
  email,
  first_name,
  last_name
) VALUES (
  'ff2df806-b321-4254-b651-3af11fccf1db'::uuid,
  'bnms',
  'dc156a30-ae8d-4aee-b965-b54fe4b17105',
  '6111f611-9daf-4011-847c-86e2bc616740',
  '3d291826-13d8-4fc1-9221-7627fc45830a'::uuid,
  'sharon@onlinem.co.uk',
  'Sharon',
  'Bacon'
);

DO $preconditions$
DECLARE
  s _sharon_bnms_scope%ROWTYPE;
  v_tenant_count integer;
  v_identity_count integer;
  v_membership_count integer;
  v_credential_count integer;
  v_legacy_user_count integer;
  v_tenant_member_count integer;
  v_exact_member_count integer;
  v_membership_member_id text;
  v_portal_disabled boolean;
BEGIN
  SELECT * INTO STRICT s FROM _sharon_bnms_scope;

  SELECT count(*),
         bool_or(COALESCE((t.settings->>'member_portal_login_enabled')::boolean, true) IS FALSE)
    INTO v_tenant_count, v_portal_disabled
  FROM public.tenant t
  WHERE t.id = s.tenant_id
    AND lower(t.slug) = s.tenant_slug;

  IF v_tenant_count <> 1 THEN
    RAISE EXCEPTION 'Expected exactly one pinned BNMS tenant; found %', v_tenant_count;
  END IF;

  IF v_portal_disabled IS TRUE THEN
    RAISE EXCEPTION 'BNMS member portal is explicitly disabled; refusing to create an unassigned Member';
  END IF;

  SELECT count(*) INTO v_identity_count
  FROM public.tenant_identity ti
  WHERE ti.id = s.identity_id
    AND lower(ti.email) = s.email
    AND ti.first_name = s.first_name
    AND ti.last_name = s.last_name
    AND ti.is_temporary IS FALSE
    AND ti.password_hash IS NOT NULL;

  IF v_identity_count <> 1 THEN
    RAISE EXCEPTION 'Pinned Sharon identity is missing, ambiguous, temporary, or not password-ready';
  END IF;

  SELECT count(*), max(tm.member_id::text)
    INTO v_membership_count, v_membership_member_id
  FROM public.tenant_membership tm
  WHERE tm.id = s.membership_id
    AND tm.identity_id = s.identity_id
    AND tm.tenant_id = s.tenant_id
    AND tm.status = 'active'
    AND tm.role = 'admin'
    AND tm.membership_type = 'owner';

  IF v_membership_count <> 1 THEN
    RAISE EXCEPTION 'Expected exactly one active pinned BNMS admin membership';
  END IF;

  SELECT count(*) INTO v_credential_count
  FROM public.tenant_membership_credentials tmc
  WHERE tmc.identity_id = s.identity_id
    AND tmc.tenant_id = s.tenant_id
    AND tmc.password_hash IS NOT NULL
    AND tmc.reset_token IS NULL;

  IF v_credential_count <> 1 THEN
    RAISE EXCEPTION 'Expected exactly one recovery-ready BNMS tenant credential; found %', v_credential_count;
  END IF;

  SELECT count(*) INTO v_legacy_user_count
  FROM public.tenant_user tu
  WHERE tu.tenant_id = s.tenant_id
    AND lower(tu.email) = s.email;

  IF v_legacy_user_count <> 0 THEN
    RAISE EXCEPTION 'Unexpected legacy BNMS tenant_user exists for Sharon';
  END IF;

  SELECT count(*) INTO v_tenant_member_count
  FROM public.member m
  WHERE m.tenant_id = s.tenant_id;

  SELECT count(*) INTO v_exact_member_count
  FROM public.member m
  WHERE m.id = s.member_id
    AND m.tenant_id = s.tenant_id
    AND m.identity_id = s.identity_id
    AND lower(m.email) = s.email
    AND m.first_name = s.first_name
    AND m.last_name = s.last_name
    AND m.organization_id IS NULL
    AND m.status = 'active'
    AND m.login_enabled IS TRUE
    AND m.membership_paused IS NOT TRUE
    AND m.is_guest IS FALSE
    AND m.is_sample IS FALSE;

  IF v_tenant_member_count = 0 THEN
    IF v_membership_member_id IS NOT NULL THEN
      RAISE EXCEPTION 'Zero-member baseline has an unexpected membership member_id: %', v_membership_member_id;
    END IF;
  ELSIF v_tenant_member_count = 1
        AND v_exact_member_count = 1
        AND v_membership_member_id = s.member_id::text THEN
    RAISE NOTICE 'Exact recovery state already exists; this run is an idempotent no-op';
  ELSE
    RAISE EXCEPTION
      'Expected zero BNMS Members or the exact applied state; found total %, exact %, linked member %',
      v_tenant_member_count,
      v_exact_member_count,
      COALESCE(v_membership_member_id, '(null)');
  END IF;
END
$preconditions$;

-- PREVIEW 1: the exact existing identity and membership that will be reused.
SELECT
  ti.id AS identity_id,
  lower(ti.email) AS email,
  ti.first_name,
  ti.last_name,
  ti.is_temporary,
  (ti.password_hash IS NOT NULL) AS identity_password_ready,
  tm.id AS membership_id,
  tm.tenant_id,
  tm.role,
  tm.membership_type,
  tm.status AS membership_status,
  tm.member_id AS member_id_before
FROM _sharon_bnms_scope s
JOIN public.tenant_identity ti ON ti.id = s.identity_id
JOIN public.tenant_membership tm ON tm.id = s.membership_id;

-- PREVIEW 2: the minimal Member exception. It is deliberately private and
-- unassigned because BNMS member-portal login is currently enabled.
SELECT
  s.member_id,
  s.tenant_id,
  s.identity_id,
  s.email,
  s.first_name,
  s.last_name,
  NULL::uuid AS organization_id,
  'active'::text AS status,
  true AS login_enabled,
  false AS show_in_directory,
  false AS membership_paused,
  false AS is_guest,
  false AS is_sample
FROM _sharon_bnms_scope s;

INSERT INTO public.member (
  id,
  tenant_id,
  identity_id,
  email,
  first_name,
  last_name,
  organization_id,
  status,
  login_enabled,
  show_in_directory,
  membership_paused,
  is_guest,
  is_sample
)
SELECT
  s.member_id,
  s.tenant_id,
  s.identity_id,
  s.email,
  s.first_name,
  s.last_name,
  NULL,
  'active',
  true,
  false,
  false,
  false,
  false
FROM _sharon_bnms_scope s
WHERE NOT EXISTS (
  SELECT 1 FROM public.member m WHERE m.id = s.member_id
);

UPDATE public.tenant_membership tm
SET member_id = s.member_id::text,
    updated_at = now()
FROM _sharon_bnms_scope s
WHERE tm.id = s.membership_id
  AND tm.identity_id = s.identity_id
  AND tm.tenant_id = s.tenant_id
  AND tm.member_id IS NULL;

DO $postconditions$
DECLARE
  s _sharon_bnms_scope%ROWTYPE;
  v_member_count integer;
  v_link_count integer;
  v_identity_count integer;
  v_membership_count integer;
  v_credential_count integer;
  v_legacy_user_count integer;
BEGIN
  SELECT * INTO STRICT s FROM _sharon_bnms_scope;

  SELECT count(*) INTO v_member_count
  FROM public.member m
  WHERE m.id = s.member_id
    AND m.tenant_id = s.tenant_id
    AND m.identity_id = s.identity_id
    AND lower(m.email) = s.email
    AND m.first_name = s.first_name
    AND m.last_name = s.last_name
    AND m.organization_id IS NULL
    AND m.status = 'active'
    AND m.login_enabled IS TRUE
    AND m.show_in_directory IS FALSE
    AND m.membership_paused IS NOT TRUE
    AND m.is_guest IS FALSE
    AND m.is_sample IS FALSE;

  IF v_member_count <> 1 THEN
    RAISE EXCEPTION 'Postcondition failed: exact active Sharon Member count is %', v_member_count;
  END IF;

  SELECT count(*) INTO v_link_count
  FROM public.tenant_membership tm
  WHERE tm.id = s.membership_id
    AND tm.identity_id = s.identity_id
    AND tm.tenant_id = s.tenant_id
    AND tm.member_id::text = s.member_id::text
    AND tm.status = 'active'
    AND tm.role = 'admin'
    AND tm.membership_type = 'owner';

  IF v_link_count <> 1 THEN
    RAISE EXCEPTION 'Postcondition failed: exact Sharon membership link count is %', v_link_count;
  END IF;

  SELECT count(*) INTO v_identity_count
  FROM public.tenant_identity ti
  WHERE ti.id = s.identity_id AND lower(ti.email) = s.email;

  SELECT count(*) INTO v_membership_count
  FROM public.tenant_membership tm
  WHERE tm.id = s.membership_id
    AND tm.identity_id = s.identity_id
    AND tm.tenant_id = s.tenant_id;

  SELECT count(*) INTO v_credential_count
  FROM public.tenant_membership_credentials tmc
  WHERE tmc.identity_id = s.identity_id
    AND tmc.tenant_id = s.tenant_id
    AND tmc.password_hash IS NOT NULL
    AND tmc.reset_token IS NULL;

  SELECT count(*) INTO v_legacy_user_count
  FROM public.tenant_user tu
  WHERE tu.tenant_id = s.tenant_id AND lower(tu.email) = s.email;

  IF v_identity_count <> 1
     OR v_membership_count <> 1
     OR v_credential_count <> 1
     OR v_legacy_user_count <> 0 THEN
    RAISE EXCEPTION
      'Auth-boundary postcondition failed: identities %, memberships %, credentials %, legacy users %',
      v_identity_count,
      v_membership_count,
      v_credential_count,
      v_legacy_user_count;
  END IF;

  IF (SELECT count(*) FROM public.member m WHERE m.tenant_id = s.tenant_id) <> 1 THEN
    RAISE EXCEPTION 'Postcondition failed: BNMS does not have exactly one Member';
  END IF;
END
$postconditions$;

-- FINAL REVIEW: these must be the only BNMS Member and its one unified link.
SELECT
  m.id AS member_id,
  m.tenant_id,
  m.identity_id,
  m.email,
  m.first_name,
  m.last_name,
  m.organization_id,
  m.status,
  m.login_enabled,
  m.show_in_directory,
  m.membership_paused,
  tm.id AS membership_id,
  tm.role AS admin_role,
  tm.membership_type,
  tm.status AS membership_status
FROM _sharon_bnms_scope s
JOIN public.member m ON m.id = s.member_id
JOIN public.tenant_membership tm
  ON tm.id = s.membership_id
 AND tm.member_id::text = m.id::text;

-- SAFE DEFAULT. After reviewing the previews and final result, replace this
-- ROLLBACK line with exactly COMMIT and run the entire file once.
ROLLBACK;