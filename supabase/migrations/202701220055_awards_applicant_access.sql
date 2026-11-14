BEGIN;
CREATE TABLE public.awards_applicant_access (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  application_id uuid NOT NULL,
  delivery_id uuid NOT NULL UNIQUE REFERENCES public.awards_delivery(id) ON DELETE RESTRICT,
  token_hash text NOT NULL UNIQUE CHECK(token_hash ~ '^[a-f0-9]{64}$'),
  email_hash text NOT NULL CHECK(email_hash ~ '^[a-f0-9]{64}$'),
  credential_envelope jsonb NOT NULL CHECK(jsonb_typeof(credential_envelope)='object'),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(tenant_id,application_id,id),
  FOREIGN KEY(tenant_id,application_id) REFERENCES public.awards_application(tenant_id,id)
);
ALTER TABLE public.awards_applicant_access ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.awards_applicant_access FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.awards_applicant_access TO service_role;
CREATE FUNCTION public.awards_external_applicant(p_tenant uuid,p_application uuid,p_hash text)
RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
  SELECT access.id FROM public.awards_applicant_access access
    JOIN public.awards_application a ON a.tenant_id=access.tenant_id AND a.id=access.application_id
    JOIN public.form_submission s ON s.tenant_id=a.tenant_id AND s.id=a.submission_id
  WHERE access.tenant_id=p_tenant AND access.application_id=p_application AND access.token_hash=p_hash
    AND access.revoked_at IS NULL AND access.expires_at>clock_timestamp() AND a.member_id IS NULL
    AND access.email_hash=encode(sha256(convert_to(lower(btrim(s.submitted_by_email)),'UTF8')),'hex');
$$;
CREATE FUNCTION public.awards_issue_applicant_access(p_tenant uuid,p_application uuid,p_delivery uuid,p_claim uuid,p_hash text,p_envelope jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE a public.awards_application; d public.awards_delivery; saved public.awards_applicant_access; email text;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'Service authority required' USING ERRCODE='42501'; END IF;
  SELECT * INTO a FROM public.awards_application WHERE tenant_id=p_tenant AND id=p_application;
  IF NOT FOUND OR a.member_id IS NOT NULL THEN RAISE EXCEPTION 'External application unavailable' USING ERRCODE='42501'; END IF;
  PERFORM 1 FROM public.awards_competition WHERE tenant_id=p_tenant AND id=a.award_id FOR UPDATE;
  SELECT * INTO a FROM public.awards_application WHERE tenant_id=p_tenant AND id=p_application FOR UPDATE;
  SELECT * INTO d FROM public.awards_delivery WHERE tenant_id=p_tenant AND award_id=a.award_id AND id=p_delivery FOR UPDATE;
  IF NOT FOUND OR d.state<>'claimed' OR d.claim_token IS DISTINCT FROM p_claim OR d.lease_until<=clock_timestamp()
    OR d.sending_started_at IS NOT NULL OR d.recipient_context->>'application_id' IS DISTINCT FROM a.id::text
    OR d.category NOT IN ('application_confirmation','application_deadline','shortlist','winner','unsuccessful')
    OR NOT public.awards_message_authority(p_tenant,a.award_id,d.category,d.recipient_context,d.release_id) THEN
    RAISE EXCEPTION 'Claimed authorised applicant message required' USING ERRCODE='42501'; END IF;
  SELECT lower(btrim(submitted_by_email)) INTO email FROM public.form_submission WHERE tenant_id=p_tenant AND id=a.submission_id;
  IF email IS NULL OR email !~ '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$' THEN RAISE EXCEPTION 'Canonical applicant email unavailable' USING ERRCODE='42501'; END IF;
  SELECT * INTO saved FROM public.awards_applicant_access WHERE delivery_id=d.id;
  IF FOUND THEN
    IF public.awards_external_applicant(p_tenant,a.id,saved.token_hash) IS NULL THEN RAISE EXCEPTION 'Applicant access expired or revoked' USING ERRCODE='42501'; END IF;
    RETURN jsonb_build_object('id',saved.id,'envelope',saved.credential_envelope,'expiresAt',saved.expires_at,'email',email);
  END IF;
  IF p_hash IS NULL OR p_hash !~ '^[a-f0-9]{64}$' OR jsonb_typeof(p_envelope) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'Valid protected credential required'; END IF;
  INSERT INTO public.awards_applicant_access(tenant_id,application_id,delivery_id,token_hash,email_hash,credential_envelope,expires_at)
    VALUES(p_tenant,a.id,d.id,p_hash,encode(sha256(convert_to(email,'UTF8')),'hex'),p_envelope,clock_timestamp()+interval '7 days') RETURNING * INTO saved;
  INSERT INTO public.awards_audit_event(tenant_id,award_id,actor_kind,action,subject_id,changes)
    VALUES(p_tenant,a.award_id,'system','application.access_issued',a.id,jsonb_build_object('access_id',saved.id,'expires_at',saved.expires_at));
  RETURN jsonb_build_object('id',saved.id,'envelope',saved.credential_envelope,'expiresAt',saved.expires_at,'email',email);
END $$;
REVOKE ALL ON FUNCTION public.awards_external_applicant(uuid,uuid,text) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.awards_issue_applicant_access(uuid,uuid,uuid,uuid,text,jsonb) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.awards_issue_applicant_access(uuid,uuid,uuid,uuid,text,jsonb) TO service_role;
COMMIT;
