BEGIN;
CREATE TABLE public.awards_message_configuration (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  award_id uuid NOT NULL,
  category text NOT NULL CHECK(category IN ('application_confirmation','application_deadline','judge_invitation',
    'judge_invitation_reminder','judging_deadline','incomplete_assessment','moderation_invitation','shortlist','unsuccessful','winner','certificate')),
  email_template_id uuid REFERENCES public.email_template(id) ON DELETE RESTRICT,
  enabled boolean NOT NULL DEFAULT true,
  version bigint NOT NULL DEFAULT 1,
  UNIQUE(award_id,category),
  FOREIGN KEY(tenant_id,award_id) REFERENCES public.awards_competition(tenant_id,id)
);
ALTER TABLE public.awards_message_configuration ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.awards_message_configuration FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.awards_message_configuration TO service_role;
CREATE FUNCTION public.awards_configure_message(p_tenant uuid,p_award uuid,p_category text,p_template uuid,p_enabled boolean,
  p_version bigint,p_actor_kind text,p_actor uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE config public.awards_message_configuration;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'Service authority required' USING ERRCODE='42501'; END IF;
  IF p_actor_kind NOT IN ('member','tenant_user') OR p_actor IS NULL OR p_enabled IS NULL THEN RAISE EXCEPTION 'Configuration authority required'; END IF;
  PERFORM 1 FROM public.awards_competition WHERE tenant_id=p_tenant AND id=p_award FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Award unavailable'; END IF;
  IF p_template IS NOT NULL THEN
    PERFORM 1 FROM public.email_template WHERE tenant_id=p_tenant AND id=p_template AND is_active FOR SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Active same-tenant email template required'; END IF;
  END IF;
  SELECT * INTO config FROM public.awards_message_configuration WHERE tenant_id=p_tenant AND award_id=p_award AND category=p_category FOR UPDATE;
  IF coalesce(config.version,0) IS DISTINCT FROM p_version THEN RAISE EXCEPTION 'Message configuration changed' USING ERRCODE='40001'; END IF;
  INSERT INTO public.awards_message_configuration(tenant_id,award_id,category,email_template_id,enabled)
    VALUES(p_tenant,p_award,p_category,p_template,p_enabled)
    ON CONFLICT(award_id,category) DO UPDATE SET email_template_id=EXCLUDED.email_template_id,enabled=EXCLUDED.enabled,
      version=awards_message_configuration.version+1 RETURNING * INTO config;
  INSERT INTO public.awards_audit_event(tenant_id,award_id,actor_kind,actor_id,action,subject_id,changes)
    VALUES(p_tenant,p_award,p_actor_kind,p_actor,'message.configured',config.id,jsonb_build_object('category',p_category,'version',config.version,'enabled',p_enabled));
  RETURN to_jsonb(config);
END $$;
CREATE FUNCTION public.awards_message_authority(p_tenant uuid,p_award uuid,p_category text,p_context jsonb,p_release uuid)
RETURNS boolean LANGUAGE plpgsql STABLE SET search_path=pg_catalog,public AS $$
DECLARE a public.awards_application; j public.assessment_appointment; r public.assessment_round; outcome public.awards_outcome_revision;
BEGIN
  IF EXISTS(SELECT 1 FROM public.awards_message_configuration WHERE tenant_id=p_tenant AND award_id=p_award AND category=p_category AND NOT enabled) THEN RETURN false; END IF;
  IF EXISTS(SELECT 1 FROM public.awards_message_configuration config WHERE config.tenant_id=p_tenant AND config.award_id=p_award AND config.category=p_category
    AND config.email_template_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.email_template t
      WHERE t.id=config.email_template_id AND t.tenant_id=p_tenant AND t.is_active)) THEN RETURN false; END IF;
  IF p_category IN ('application_confirmation','application_deadline','shortlist','unsuccessful','winner','certificate') THEN
    SELECT * INTO a FROM public.awards_application WHERE tenant_id=p_tenant AND award_id=p_award AND id=(p_context->>'application_id')::uuid;
    IF NOT FOUND OR a.eligibility='withdrawn' THEN RETURN false; END IF;
    IF p_context ? 'automatic_deadline' AND NOT EXISTS(SELECT 1 FROM public.awards_competition WHERE id=p_award AND tenant_id=p_tenant
      AND closes_at=(p_context->>'automatic_deadline')::timestamptz) THEN RETURN false; END IF;
    IF p_category='application_deadline' AND NOT EXISTS(SELECT 1 FROM public.awards_competition WHERE tenant_id=p_tenant AND id=p_award AND state='open' AND closes_at>clock_timestamp()) THEN RETURN false; END IF;
    IF p_category='shortlist' THEN RETURN EXISTS(SELECT 1 FROM public.assessment_shortlist_decision s
      JOIN public.awards_delivery_release release ON release.shortlist_id=s.id
      WHERE release.tenant_id=p_tenant AND release.id=p_release AND s.tenant_id=p_tenant AND s.award_id=p_award
        AND s.application_id=a.id AND s.id=(p_context->>'shortlist_id')::uuid AND s.state='confirmed'
        AND public.awards_shortlist_is_current(p_tenant,s.id)
        AND NOT EXISTS(SELECT 1 FROM public.assessment_shortlist_decision newer WHERE newer.round_id=s.round_id AND newer.application_id=s.application_id AND newer.revision>s.revision)); END IF;
    IF p_category IN ('unsuccessful','winner','certificate') THEN
      IF NOT public.awards_outcome_is_current(p_tenant,(p_context->>'outcome_id')::uuid) THEN RETURN false; END IF;
      SELECT o.* INTO outcome FROM public.awards_outcome_revision o JOIN public.awards_delivery_release release ON release.outcome_revision_id=o.id
        WHERE release.tenant_id=p_tenant AND release.id=p_release AND o.tenant_id=p_tenant AND o.award_id=p_award AND o.application_id=a.id
          AND o.id=(p_context->>'outcome_id')::uuid AND o.state='approved'
          AND NOT EXISTS(SELECT 1 FROM public.awards_outcome_revision newer WHERE newer.application_id=a.id AND newer.revision>o.revision);
      IF NOT FOUND THEN RETURN false; END IF;
      IF p_category='certificate' AND NOT EXISTS(SELECT 1 FROM public.awards_certificate_issue WHERE tenant_id=p_tenant AND outcome_revision_id=outcome.id
        AND id=(p_context->>'issue_id')::uuid) THEN RETURN false; END IF;
      IF p_category='certificate' AND p_context->>'access_id' IS NOT NULL AND NOT EXISTS(
        SELECT 1 FROM public.awards_certificate_access WHERE tenant_id=p_tenant AND id=(p_context->>'access_id')::uuid
          AND issue_id=(p_context->>'issue_id')::uuid AND revoked_at IS NULL AND expires_at>clock_timestamp()
      ) THEN RETURN false; END IF;
    END IF;
    RETURN true;
  END IF;
  SELECT * INTO j FROM public.assessment_appointment WHERE tenant_id=p_tenant AND id=(p_context->>'appointment_id')::uuid;
  IF NOT FOUND OR j.expires_at<=clock_timestamp() OR j.credential_generation IS DISTINCT FROM (p_context->>'generation')::bigint THEN RETURN false; END IF;
  SELECT * INTO r FROM public.assessment_round WHERE tenant_id=p_tenant AND award_id=p_award AND id=j.round_id;
  IF NOT FOUND OR r.state='closed' THEN RETURN false; END IF;
  IF p_context ? 'automatic_round_version' AND (r.state<>'moderation' OR r.version IS DISTINCT FROM (p_context->>'automatic_round_version')::bigint) THEN RETURN false; END IF;
  IF p_context ? 'automatic_deadline' AND (p_context->>'automatic_deadline')::timestamptz IS DISTINCT FROM
    (CASE WHEN p_category='judge_invitation_reminder' THEN coalesce(
      (SELECT i.expires_at FROM public.assessment_invitation i WHERE i.appointment_id=j.id AND i.generation=j.credential_generation
        AND i.revoked_at IS NULL ORDER BY i.created_at DESC LIMIT 1),j.expires_at,r.closes_at)
      ELSE r.closes_at END) THEN RETURN false; END IF;
  IF p_category IN ('judge_invitation','judge_invitation_reminder') THEN RETURN j.state='invited' AND (j.member_id IS NOT NULL OR EXISTS(
    SELECT 1 FROM public.assessment_invitation i WHERE i.appointment_id=j.id AND i.generation=j.credential_generation
      AND i.revoked_at IS NULL AND i.redeemed_at IS NULL AND i.expires_at>clock_timestamp())); END IF;
  IF j.state<>'accepted' THEN RETURN false; END IF;
  IF p_category='moderation_invitation' THEN RETURN j.role=ANY(r.moderation_proposers||r.moderation_approvers||r.moderation_discussion)
    AND r.state IN ('judging','moderation'); END IF;
  IF p_category NOT IN ('judging_deadline','incomplete_assessment') OR r.state<>'judging' OR r.closes_at<=clock_timestamp() THEN RETURN false; END IF;
  IF p_category='incomplete_assessment' THEN RETURN EXISTS(SELECT 1 FROM public.assessment_assignment s WHERE s.tenant_id=p_tenant AND s.appointment_id=j.id
    AND s.state='assigned' AND s.conflict IN ('none','cleared') AND coalesce((SELECT v.state FROM public.assessment_revision v WHERE v.assignment_id=s.id ORDER BY revision DESC LIMIT 1),'')<>'submitted'); END IF;
  RETURN true;
END $$;
CREATE FUNCTION public.awards_queue_message(p_tenant uuid,p_award uuid,p_category text,p_context jsonb,p_release uuid,
  p_due timestamptz,p_request uuid,p_actor_kind text,p_actor uuid,p_reason text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE delivery public.awards_delivery;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'Service authority required' USING ERRCODE='42501'; END IF;
  IF p_actor_kind NOT IN ('member','tenant_user','system') OR (p_actor_kind<>'system' AND p_actor IS NULL) OR p_request IS NULL OR p_due IS NULL
    OR p_category='judge_invitation' OR length(btrim(coalesce(p_reason,'')))=0 THEN RAISE EXCEPTION 'Message scheduling authority required'; END IF;
  PERFORM 1 FROM public.awards_competition WHERE tenant_id=p_tenant AND id=p_award FOR UPDATE;
  IF NOT FOUND OR NOT public.awards_message_authority(p_tenant,p_award,p_category,p_context,p_release) THEN RAISE EXCEPTION 'Recipient or release is no longer eligible'; END IF;
  SELECT * INTO delivery FROM public.awards_delivery WHERE tenant_id=p_tenant AND deduplication_key='message:'||p_request::text;
  IF FOUND THEN
    IF delivery.award_id<>p_award OR delivery.category<>p_category OR delivery.recipient_context IS DISTINCT FROM p_context
      OR delivery.release_id IS DISTINCT FROM p_release OR delivery.requested_due_at IS DISTINCT FROM p_due THEN RAISE EXCEPTION 'Request already used for different message content' USING ERRCODE='23505'; END IF;
  ELSE
    INSERT INTO public.awards_delivery(tenant_id,award_id,category,recipient_context,release_id,due_at,requested_due_at,deduplication_key)
      VALUES(p_tenant,p_award,p_category,p_context,p_release,p_due,p_due,'message:'||p_request::text) RETURNING * INTO delivery;
    INSERT INTO public.awards_audit_event(tenant_id,award_id,actor_kind,actor_id,action,subject_id,reason,changes)
      VALUES(p_tenant,p_award,p_actor_kind,p_actor,'message.scheduled',delivery.id,p_reason,jsonb_build_object('category',p_category,'due_at',p_due));
  END IF;
  RETURN jsonb_build_object('id',delivery.id,'state',delivery.state,'due_at',delivery.due_at);
END $$;
CREATE FUNCTION public.awards_claim_messages(p_limit integer DEFAULT 5)
RETURNS SETOF public.awards_delivery LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'Service authority required' USING ERRCODE='42501'; END IF;
  UPDATE public.awards_delivery SET state='attention',last_error_code='UNCERTAIN_PROVIDER_OUTCOME',claim_token=NULL,lease_until=NULL
    WHERE state='claimed' AND lease_until<clock_timestamp() AND sending_started_at IS NOT NULL;
  RETURN QUERY WITH chosen AS (
    SELECT id FROM public.awards_delivery WHERE category<>'judge_invitation' AND due_at<=clock_timestamp()
      AND (state IN ('pending','retry') OR state='claimed' AND lease_until<clock_timestamp() AND sending_started_at IS NULL)
    ORDER BY due_at,id FOR UPDATE SKIP LOCKED LIMIT least(greatest(p_limit,1),10)
  ) UPDATE public.awards_delivery d SET state='claimed',claim_token=gen_random_uuid(),lease_until=clock_timestamp()+interval '3 minutes',attempts=attempts+1
    FROM chosen WHERE d.id=chosen.id RETURNING d.*;
END $$;
REVOKE ALL ON FUNCTION public.awards_configure_message(uuid,uuid,text,uuid,boolean,bigint,text,uuid) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.awards_message_authority(uuid,uuid,text,jsonb,uuid) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.awards_queue_message(uuid,uuid,text,jsonb,uuid,timestamptz,uuid,text,uuid,text) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.awards_claim_messages(integer) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.awards_configure_message(uuid,uuid,text,uuid,boolean,bigint,text,uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.awards_queue_message(uuid,uuid,text,jsonb,uuid,timestamptz,uuid,text,uuid,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.awards_claim_messages(integer) TO service_role;
COMMIT;
