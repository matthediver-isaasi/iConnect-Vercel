-- Forward-only genuine login evidence. This does not certify historical
-- coverage, enable Auto Archive, backfill timestamps or alter any member.
BEGIN;
CREATE TABLE IF NOT EXISTS public.member_lifecycle_login_evidence (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  member_id uuid NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  source text NOT NULL CHECK (source IN ('password','google','password_setup','mobile_password'))
);
CREATE INDEX IF NOT EXISTS member_lifecycle_login_evidence_latest
  ON public.member_lifecycle_login_evidence(tenant_id,member_id,occurred_at DESC,id);
ALTER TABLE public.member_lifecycle_login_evidence ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.member_lifecycle_login_evidence FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.member_lifecycle_login_evidence TO service_role;
DROP POLICY IF EXISTS member_lifecycle_login_service_read ON public.member_lifecycle_login_evidence;
CREATE POLICY member_lifecycle_login_service_read ON public.member_lifecycle_login_evidence
  FOR SELECT TO service_role USING (true);

CREATE OR REPLACE FUNCTION public.capture_member_lifecycle_login()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE
  previous jsonb;
  current_session jsonb := NEW.sess::jsonb;
  marker jsonb := current_session->'memberLoginEvidence';
  member_tenant uuid;
  event_id uuid;
  member_id uuid;
  tenant_id uuid;
BEGIN
  IF TG_OP='UPDATE' THEN previous := OLD.sess::jsonb; END IF;
  IF marker IS NULL THEN RETURN NEW; END IF;
  -- Replaying a normal update must not produce another event or refresh dates.
  IF TG_OP='UPDATE' AND previous->'memberLoginEvidence' IS NOT DISTINCT FROM marker THEN
    RETURN NEW;
  END IF;
  IF TG_OP<>'UPDATE' OR previous ? 'memberLoginEvidence' THEN
    RAISE EXCEPTION 'Login evidence requires a newly finalized session';
  END IF;
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'service_role is required';
  END IF;
  IF jsonb_typeof(marker)<>'object' OR marker->>'version' IS DISTINCT FROM '1'
    OR marker->>'source' IS NULL
    OR marker->>'source' NOT IN ('password','google','password_setup','mobile_password')
    OR current_session->>'userType' IS DISTINCT FROM 'member'
    OR NULLIF(current_session->>'tenantUserId','') IS NOT NULL
    OR COALESCE(current_session->>'isMasquerading','false')<>'false'
    OR COALESCE(current_session->>'isPlatformImpersonation','false')<>'false'
    OR NULLIF(current_session->>'masqueradeAdminSessionId','') IS NOT NULL
    OR COALESCE(current_session->>'promotedFromMember','false')<>'false'
    OR NULLIF(current_session->>'originalUserType','') IS NOT NULL
    OR NEW.expire IS NULL OR NEW.expire <= clock_timestamp()
    OR (current_session-'memberLoginEvidence') IS DISTINCT FROM previous THEN
    RAISE EXCEPTION 'Invalid genuine member login';
  END IF;
  event_id := (marker->>'id')::uuid;
  member_id := (current_session->>'memberId')::uuid;
  tenant_id := (current_session->>'tenantId')::uuid;
  IF event_id IS NULL OR member_id IS NULL OR tenant_id IS NULL THEN
    RAISE EXCEPTION 'Login evidence identity is required';
  END IF;
  SELECT COALESCE(m.tenant_id,o.tenant_id) INTO member_tenant
    FROM public.member m LEFT JOIN public.organization o ON o.id=m.organization_id
    WHERE m.id=member_id;
  IF member_tenant IS DISTINCT FROM tenant_id THEN
    RAISE EXCEPTION 'Login evidence member scope mismatch';
  END IF;
  INSERT INTO public.member_lifecycle_login_evidence(id,tenant_id,member_id,source)
    VALUES(event_id,tenant_id,member_id,marker->>'source');
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.capture_member_lifecycle_login() FROM PUBLIC,anon,authenticated,service_role;
DROP TRIGGER IF EXISTS capture_member_lifecycle_login ON public.session;
CREATE TRIGGER capture_member_lifecycle_login BEFORE INSERT OR UPDATE ON public.session
  FOR EACH ROW EXECUTE FUNCTION public.capture_member_lifecycle_login();
NOTIFY pgrst,'reload schema';
COMMIT;
