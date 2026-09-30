-- Prospective policy only. No historical entitlement or response is rewritten.
CREATE TABLE IF NOT EXISTS public.survey_completion (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenant(id),
  form_id uuid NOT NULL REFERENCES public.form(id),
  assignment_id uuid REFERENCES public.event_survey_assignment(id),
  member_id uuid REFERENCES public.member(id) ON DELETE SET NULL,
  recipient_email text NOT NULL CHECK (recipient_email = lower(trim(recipient_email))),
  completed_day date NOT NULL DEFAULT current_date
);
CREATE UNIQUE INDEX IF NOT EXISTS survey_completion_scope_email
  ON public.survey_completion(tenant_id, form_id, coalesce(assignment_id,'00000000-0000-0000-0000-000000000000'::uuid),recipient_email);
-- This ledger has no response ID, answer digest, version ID, or acceptance time.
-- Retry keys are never stored on answer rows. It is not an answer lookup index.
CREATE TABLE IF NOT EXISTS public.survey_completion_retry (
  tenant_id uuid NOT NULL,
  form_id uuid NOT NULL,
  scope_id uuid NOT NULL,
  principal text NOT NULL,
  retry_hash text NOT NULL,
  PRIMARY KEY (tenant_id, form_id, scope_id, principal, retry_hash)
);
ALTER TABLE public.survey_completion ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.survey_completion_retry ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.survey_completion, public.survey_completion_retry FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.survey_completion TO service_role;

ALTER TABLE public.certificate_survey_entitlement
  ADD COLUMN IF NOT EXISTS anonymous_completion_version integer
    CHECK (anonymous_completion_version IS NULL OR anonymous_completion_version=1);
CREATE OR REPLACE FUNCTION public.guard_certificate_survey_entitlement() RETURNS trigger
LANGUAGE plpgsql SET search_path = public AS $fn$
BEGIN
  IF TG_OP='INSERT' AND (NEW.completed_at IS NOT NULL OR NEW.response_id IS NOT NULL
    OR NEW.anonymous_completion_version IS NOT NULL) THEN
    RAISE EXCEPTION 'Survey entitlement cannot start completed';
  END IF;
  IF TG_OP='UPDATE' AND (
    (OLD.completed_at IS NOT NULL AND NEW.completed_at IS DISTINCT FROM OLD.completed_at)
    OR (OLD.response_id IS NOT NULL AND NEW.response_id IS DISTINCT FROM OLD.response_id)
    OR (OLD.completed_at IS NOT NULL AND NEW.anonymous_completion_version IS DISTINCT FROM OLD.anonymous_completion_version)
    OR (OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at)
    OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
    OR NEW.booking_source IS DISTINCT FROM OLD.booking_source
    OR NEW.booking_id IS DISTINCT FROM OLD.booking_id
    OR NEW.assignment_id IS DISTINCT FROM OLD.assignment_id
    OR NEW.recipient_email IS DISTINCT FROM OLD.recipient_email
  ) THEN RAISE EXCEPTION 'Survey entitlement scope, completion and revocation are immutable'; END IF;
  IF NEW.anonymous_completion_version=1 THEN
    IF NEW.response_id IS NOT NULL OR NEW.completed_at IS NULL OR NOT EXISTS(
      SELECT 1 FROM public.survey_completion c
      WHERE c.tenant_id=NEW.tenant_id AND c.assignment_id=NEW.assignment_id
        AND c.recipient_email=NEW.recipient_email
    ) THEN RAISE EXCEPTION 'Anonymous completion evidence required without response linkage'; END IF;
  ELSIF (NEW.response_id IS NULL) IS DISTINCT FROM (NEW.completed_at IS NULL) THEN
    RAISE EXCEPTION 'Survey completion and response evidence must change together';
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.accept_anonymous_survey_completion(
  p_submission jsonb, p_answers jsonb, p_member_id uuid, p_token_hash text, p_retry_hash text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE
  v_tenant uuid := (p_submission->>'tenant_id')::uuid;
  v_form_id uuid := (p_submission->>'form_id')::uuid;
  v_version_id uuid := (p_submission->>'survey_version_id')::uuid;
  v_assignment_id uuid := (p_submission->>'survey_assignment_id')::uuid;
  v_scope uuid := coalesce(v_assignment_id,'00000000-0000-0000-0000-000000000000'::uuid);
  v_form public.form;
  v_settings jsonb;
  v_assignment public.event_survey_assignment;
  v_credential public.certificate_survey_credential;
  v_grant public.certificate_survey_entitlement;
  v_email text;
  v_principal text;
  v_booking_email text;
  v_booking_status text;
  v_booking_event uuid;
  v_row public.form_submission;
  v_payload jsonb;
  v_bad text;
BEGIN
  IF v_tenant IS NULL OR v_form_id IS NULL OR v_version_id IS NULL
    OR p_retry_hash IS NULL OR p_retry_hash !~ '^[a-f0-9]{64}$' THEN
    RAISE EXCEPTION 'Invalid survey acceptance scope';
  END IF;
  -- Uniform lock order serializes retries and completion checks, including
  -- member and invitation routes identifying the same recipient.
  PERFORM pg_advisory_xact_lock(hashtextextended(v_tenant::text || ':' || v_form_id::text, 0));
  SELECT * INTO v_form FROM public.form WHERE id=v_form_id AND tenant_id=v_tenant FOR SHARE;
  SELECT survey_settings INTO v_settings FROM public.survey_version
    WHERE id=v_version_id AND tenant_id=v_tenant AND form_id=v_form_id
      AND version_number=(v_form.survey_settings->>'current_version')::integer FOR SHARE;
  IF v_form.id IS NULL OR v_form.form_type <> 'survey' OR NOT v_form.is_active
    OR v_form.survey_settings->>'status' IS DISTINCT FROM 'published'
    OR (v_form.deactivate_at IS NOT NULL AND v_form.deactivate_at<=now())
    OR v_settings->>'anonymous_completion_version' IS DISTINCT FROM '1'
    OR coalesce(v_settings->>'response_identity','') NOT IN ('anonymous','anonymous_dedupe') THEN
    RAISE EXCEPTION 'Enhanced anonymous survey publication unavailable';
  END IF;
  IF v_assignment_id IS NOT NULL THEN
    SELECT * INTO v_assignment FROM public.event_survey_assignment
      WHERE id=v_assignment_id AND tenant_id=v_tenant AND form_id=v_form_id FOR SHARE;
    IF v_assignment.id IS NULL OR v_assignment.status <> 'active'
      OR v_assignment.opens_at>now() OR v_assignment.closes_at<=now() THEN
      RAISE EXCEPTION 'Survey assignment unavailable';
    END IF;
  ELSIF EXISTS(SELECT 1 FROM public.event_survey_assignment WHERE tenant_id=v_tenant
    AND form_id=v_form_id AND status='active') THEN
    RAISE EXCEPTION 'Survey assignment required';
  END IF;
  IF p_member_id IS NOT NULL THEN
    SELECT lower(trim(email)) INTO v_email FROM public.member
      WHERE id=p_member_id AND tenant_id=v_tenant FOR SHARE;
    IF v_email IS NULL OR v_email='' THEN RAISE EXCEPTION 'Survey member unavailable'; END IF;
  END IF;
  IF p_token_hash IS NOT NULL THEN
    SELECT c.* INTO v_credential FROM public.certificate_survey_credential c
      WHERE c.token_hash=p_token_hash AND c.revoked_at IS NULL AND c.expires_at>now() FOR SHARE;
    SELECT * INTO v_grant FROM public.certificate_survey_entitlement
      WHERE id=v_credential.entitlement_id AND tenant_id=v_tenant AND assignment_id=v_assignment_id FOR UPDATE;
    IF v_grant.id IS NULL OR v_grant.revoked_at IS NOT NULL OR v_grant.expires_at<=now()
      OR NOT EXISTS(SELECT 1 FROM public.survey_invitation_delivery d
        WHERE ((d.kind='certificate' AND d.id=v_credential.delivery_id)
          OR (d.kind='campaign' AND d.id=v_credential.campaign_delivery_id))
        AND d.status='accepted' AND d.tenant_id=v_tenant
        AND d.booking_id=v_grant.booking_id AND d.booking_source=v_grant.booking_source) THEN
      RAISE EXCEPTION 'Survey invitation unavailable';
    END IF;
    IF v_grant.booking_source='standard' THEN
      SELECT attendee_email,status,event_id INTO v_booking_email,v_booking_status,v_booking_event
        FROM public.booking WHERE id=v_grant.booking_id AND tenant_id=v_tenant FOR SHARE;
      IF v_assignment.event_type IS DISTINCT FROM 'event'
        OR v_booking_event IS DISTINCT FROM v_assignment.event_id THEN RAISE EXCEPTION 'Survey booking changed'; END IF;
    ELSE
      SELECT attendee_email,status,event_id INTO v_booking_email,v_booking_status,v_booking_event
        FROM public.complex_event_booking WHERE id=v_grant.booking_id AND tenant_id=v_tenant FOR SHARE;
      IF v_assignment.event_type IS DISTINCT FROM 'complex_event'
        OR v_booking_event IS DISTINCT FROM v_assignment.complex_event_id THEN RAISE EXCEPTION 'Survey booking changed'; END IF;
    END IF;
    IF v_booking_status IS DISTINCT FROM 'confirmed'
      OR lower(trim(v_booking_email)) IS DISTINCT FROM v_grant.recipient_email
      OR (v_email IS NOT NULL AND v_email<>v_grant.recipient_email) THEN
      RAISE EXCEPTION 'Survey recipient changed';
    END IF;
    v_email := v_grant.recipient_email;
  END IF;
  v_principal := coalesce('email:' || v_email,'public');
  IF EXISTS(SELECT 1 FROM public.survey_completion_retry WHERE tenant_id=v_tenant
    AND form_id=v_form_id AND scope_id=v_scope AND principal=v_principal AND retry_hash=p_retry_hash) THEN
    RETURN '{"accepted":true,"replayed":true}'::jsonb;
  END IF;
  IF v_grant.completed_at IS NOT NULL THEN RAISE EXCEPTION 'Survey invitation already completed' USING ERRCODE='23505'; END IF;
  IF v_email IS NULL AND (v_settings->>'response_identity'='anonymous_dedupe'
    OR coalesce((v_settings->>'one_submission_per_respondent')::boolean,false)) THEN
    RAISE EXCEPTION 'Sign in or use a verified survey invitation for single-response surveys';
  END IF;
  IF v_email IS NOT NULL AND (v_settings->>'response_identity'='anonymous_dedupe'
    OR coalesce((v_settings->>'one_submission_per_respondent')::boolean,false))
    AND EXISTS(SELECT 1 FROM public.survey_completion WHERE tenant_id=v_tenant AND form_id=v_form_id
      AND assignment_id IS NOT DISTINCT FROM v_assignment_id AND recipient_email=v_email) THEN
    RAISE EXCEPTION 'Survey already completed' USING ERRCODE='23505';
  END IF;
  -- Never copy arbitrary identity, metadata, timestamps, dedupe or retry keys.
  SELECT k INTO v_bad FROM jsonb_object_keys(p_submission) k WHERE k NOT IN (
    'tenant_id','form_id','form_name','survey_version_id','survey_assignment_id','event_id','complex_event_id',
    'submission_data','survey_score_weighted','survey_score_unweighted','is_anonymous','status','source'
  ) LIMIT 1;
  IF v_bad IS NOT NULL THEN RAISE EXCEPTION 'Unexpected anonymous response column'; END IF;
  v_payload := p_submission || jsonb_build_object('is_anonymous',true,
    'event_id',v_assignment.event_id,'complex_event_id',v_assignment.complex_event_id);
  SELECT * INTO v_row FROM public.create_survey_submission(v_payload,p_answers);
  IF v_email IS NOT NULL THEN
    INSERT INTO public.survey_completion(tenant_id,form_id,assignment_id,member_id,recipient_email)
      VALUES(v_tenant,v_form_id,v_assignment_id,p_member_id,v_email) ON CONFLICT DO NOTHING;
  END IF;
  INSERT INTO public.survey_completion_retry VALUES(v_tenant,v_form_id,v_scope,v_principal,p_retry_hash);
  IF v_grant.id IS NOT NULL THEN
    -- Coarse completion only. No response_id is ever written for this policy.
    UPDATE public.certificate_survey_entitlement SET completed_at=date_trunc('day',now()), anonymous_completion_version=1
      WHERE id=v_grant.id;
  END IF;
  RETURN '{"accepted":true,"replayed":false}'::jsonb;
END;
$fn$;
REVOKE ALL ON FUNCTION public.accept_anonymous_survey_completion(jsonb,jsonb,uuid,text,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.accept_anonymous_survey_completion(jsonb,jsonb,uuid,text,text) TO service_role;