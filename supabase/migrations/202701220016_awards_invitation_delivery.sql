BEGIN;
ALTER TABLE public.awards_delivery ADD COLUMN sending_started_at timestamptz;
ALTER TABLE public.awards_delivery ADD COLUMN last_error_code text;
CREATE FUNCTION public.awards_queue_invitation(p_tenant uuid,p_appointment uuid,p_expected_version bigint,
  p_actor_kind text,p_actor uuid,p_token_hash text,p_envelope jsonb,p_reason text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE a public.assessment_appointment; r public.assessment_round; rotated jsonb; delivery uuid;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'Service authority required' USING ERRCODE='42501'; END IF;
  IF p_actor_kind NOT IN ('member','tenant_user') OR p_actor IS NULL OR length(btrim(coalesce(p_reason,'')))=0 THEN RAISE EXCEPTION 'Actor and reason required'; END IF;
  SELECT * INTO a FROM public.assessment_appointment WHERE tenant_id=p_tenant AND id=p_appointment FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Appointment unavailable' USING ERRCODE='P0002'; END IF;
  IF a.version IS DISTINCT FROM p_expected_version THEN RAISE EXCEPTION 'Appointment changed' USING ERRCODE='40001'; END IF;
  SELECT * INTO r FROM public.assessment_round WHERE tenant_id=p_tenant AND id=a.round_id;
  IF r.state='closed' OR a.expires_at<=clock_timestamp() THEN RAISE EXCEPTION 'Appointment or round expired'; END IF;
  IF a.member_id IS NULL THEN
    IF jsonb_typeof(p_envelope) IS DISTINCT FROM 'object' OR p_envelope->>'v' IS DISTINCT FROM '1'
      OR length(p_envelope::text)>2000 THEN RAISE EXCEPTION 'Encrypted invitation required'; END IF;
    rotated:=public.assessment_rotate_invitation(p_tenant,a.id,a.version,p_actor_kind,p_actor,p_token_hash,false,p_reason);
    SELECT * INTO a FROM public.assessment_appointment WHERE id=a.id;
  ELSE
    IF a.state='accepted' THEN RAISE EXCEPTION 'Member already accepted; use reminders rather than resetting their appointment'; END IF;
    UPDATE public.assessment_appointment SET state='invited',version=version+1,credential_generation=credential_generation+1
      WHERE id=a.id RETURNING * INTO a;
  END IF;
  INSERT INTO public.awards_delivery(tenant_id,award_id,deduplication_key,category,recipient_context,due_at)
    VALUES(p_tenant,r.award_id,'judging-invitation:'||a.id||':'||a.credential_generation,'judge_invitation',
      jsonb_build_object('appointment_id',a.id,'generation',a.credential_generation,'envelope',CASE WHEN a.member_id IS NULL THEN p_envelope ELSE NULL END),now())
    RETURNING id INTO delivery;
  INSERT INTO public.awards_audit_event(tenant_id,award_id,actor_kind,actor_id,action,subject_id,reason,changes)
    VALUES(p_tenant,r.award_id,p_actor_kind,p_actor,'invitation.queued',a.id,p_reason,jsonb_build_object('delivery_id',delivery,'generation',a.credential_generation));
  RETURN jsonb_build_object('appointment_id',a.id,'version',a.version,'state',a.state,'delivery_id',delivery);
END $$;
CREATE FUNCTION public.awards_claim_deliveries(p_limit integer DEFAULT 10)
RETURNS SETOF public.awards_delivery LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'Service authority required' USING ERRCODE='42501'; END IF;
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 25 THEN RAISE EXCEPTION 'Invalid delivery batch size'; END IF;
  UPDATE public.awards_delivery SET state='attention',last_error_code='UNCERTAIN_PROVIDER_OUTCOME',claim_token=NULL,lease_until=NULL
    WHERE state='claimed' AND lease_until<clock_timestamp() AND sending_started_at IS NOT NULL;
  RETURN QUERY WITH candidates AS (
    SELECT id FROM public.awards_delivery
    WHERE category='judge_invitation' AND due_at<=clock_timestamp()
      AND (state IN ('pending','retry') OR state='claimed' AND lease_until<clock_timestamp() AND sending_started_at IS NULL)
    ORDER BY due_at,id LIMIT p_limit FOR UPDATE SKIP LOCKED
  ) UPDATE public.awards_delivery d SET state='claimed',claim_token=gen_random_uuid(),
    lease_until=clock_timestamp()+interval '3 minutes',attempts=attempts+1
    FROM candidates c WHERE d.id=c.id RETURNING d.*;
END $$;
CREATE FUNCTION public.awards_delivery_result(p_tenant uuid,p_id uuid,p_claim uuid,p_action text,p_provider_id text DEFAULT NULL)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE d public.awards_delivery;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'Service authority required' USING ERRCODE='42501'; END IF;
  SELECT * INTO d FROM public.awards_delivery WHERE tenant_id=p_tenant AND id=p_id FOR UPDATE;
  IF NOT FOUND OR d.state<>'claimed' OR d.claim_token IS DISTINCT FROM p_claim OR d.lease_until<=clock_timestamp() THEN RETURN false; END IF;
  IF p_action='starting' THEN
    IF d.sending_started_at IS NOT NULL THEN RETURN false; END IF;
    IF EXISTS(SELECT 1 FROM public.awards_message_configuration WHERE tenant_id=p_tenant AND award_id=d.award_id AND category=d.category AND NOT enabled) THEN RETURN false; END IF;
    IF NOT public.awards_message_authority(p_tenant,d.award_id,d.category,d.recipient_context,d.release_id) THEN RETURN false; END IF;
    IF d.category IN ('application_confirmation','application_deadline','shortlist','winner','unsuccessful')
      AND EXISTS(SELECT 1 FROM public.awards_application a WHERE a.tenant_id=p_tenant AND a.id=(d.recipient_context->>'application_id')::uuid AND a.member_id IS NULL)
      AND NOT EXISTS(SELECT 1 FROM public.awards_applicant_access access WHERE access.tenant_id=p_tenant AND access.delivery_id=d.id
        AND public.awards_external_applicant(p_tenant,access.application_id,access.token_hash) IS NOT NULL)
    THEN RETURN false; END IF;
    IF d.category='judge_invitation' AND NOT EXISTS(
      SELECT 1 FROM public.assessment_appointment a JOIN public.assessment_round r ON r.id=a.round_id
      WHERE a.tenant_id=p_tenant AND a.id=(d.recipient_context->>'appointment_id')::uuid
        AND a.credential_generation=(d.recipient_context->>'generation')::bigint AND a.state='invited'
        AND (a.expires_at IS NULL OR a.expires_at>clock_timestamp()) AND r.state<>'closed'
    ) THEN RETURN false; END IF;
    UPDATE public.awards_delivery SET sending_started_at=clock_timestamp() WHERE id=d.id;RETURN true;
  END IF;
  IF p_action NOT IN ('delivered','retry','cancelled','attention') THEN RAISE EXCEPTION 'Invalid delivery outcome'; END IF;
  IF p_action='delivered' AND (d.sending_started_at IS NULL OR length(btrim(coalesce(p_provider_id,'')))=0) THEN
    RAISE EXCEPTION 'Provider acknowledgement required'; END IF;
  UPDATE public.awards_delivery SET state=p_action,claim_token=NULL,lease_until=NULL,
    provider_message_id=CASE WHEN p_action='delivered' THEN p_provider_id ELSE provider_message_id END,
    delivered_at=CASE WHEN p_action='delivered' THEN clock_timestamp() ELSE NULL END,
    due_at=CASE WHEN p_action='retry' THEN clock_timestamp()+interval '5 minutes' ELSE due_at END,
    sending_started_at=CASE WHEN p_action='retry' THEN NULL ELSE sending_started_at END,
    last_error_code=CASE WHEN p_action='attention' THEN 'UNCERTAIN_PROVIDER_OUTCOME' ELSE NULL END
    WHERE id=d.id;
  RETURN true;
END $$;
REVOKE ALL ON FUNCTION public.awards_queue_invitation(uuid,uuid,bigint,text,uuid,text,jsonb,text) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.awards_claim_deliveries(integer) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.awards_delivery_result(uuid,uuid,uuid,text,text) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.awards_queue_invitation(uuid,uuid,bigint,text,uuid,text,jsonb,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.awards_claim_deliveries(integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.awards_delivery_result(uuid,uuid,uuid,text,text) TO service_role;
COMMIT;
