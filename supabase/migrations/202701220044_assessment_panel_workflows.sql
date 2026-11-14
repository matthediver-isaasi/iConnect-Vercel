BEGIN;
CREATE FUNCTION public.assessment_panel_conflict_command(p_tenant uuid,p_round uuid,p_application uuid,p_member uuid,p_session_hash text,
  p_csrf_hash text,p_version bigint,p_state text,p_reason text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE r public.assessment_round; j public.assessment_appointment; c public.assessment_panel_conflict; assignment public.assessment_assignment;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'Service authority required' USING ERRCODE='42501'; END IF;
  IF p_state NOT IN ('none','potential','confirmed') OR length(btrim(coalesce(p_reason,'')))=0 THEN RAISE EXCEPTION 'Conflict decision and reason required'; END IF;
  SELECT * INTO r FROM public.assessment_round WHERE tenant_id=p_tenant AND id=p_round FOR UPDATE;
  PERFORM 1 FROM public.awards_application WHERE tenant_id=p_tenant AND award_id=r.award_id AND id=p_application FOR UPDATE;
  IF NOT FOUND OR NOT public.assessment_round_candidate(p_tenant,r.id,p_application) THEN RAISE EXCEPTION 'Round application unavailable' USING ERRCODE='42501'; END IF;
  j:=public.assessment_panel_authority(p_tenant,p_round,p_member,p_session_hash,p_csrf_hash,true);
  IF NOT (j.role=ANY(r.moderation_discussion||r.moderation_proposers||r.moderation_approvers)) THEN RAISE EXCEPTION 'Panel role unavailable' USING ERRCODE='42501'; END IF;
  SELECT * INTO c FROM public.assessment_panel_conflict WHERE appointment_id=j.id AND application_id=p_application FOR UPDATE;
  IF coalesce(c.version,0) IS DISTINCT FROM p_version THEN RAISE EXCEPTION 'Conflict declaration changed' USING ERRCODE='40001'; END IF;
  IF c.state IN ('potential','confirmed') THEN RAISE EXCEPTION 'Administrator review is required to clear a conflict'; END IF;
  INSERT INTO public.assessment_panel_conflict(tenant_id,round_id,appointment_id,application_id,state,reason)
    VALUES(p_tenant,r.id,j.id,p_application,p_state,p_reason)
    ON CONFLICT(appointment_id,application_id) DO UPDATE SET state=excluded.state,reason=excluded.reason,version=assessment_panel_conflict.version+1 RETURNING * INTO c;
  SELECT * INTO assignment FROM public.assessment_assignment WHERE tenant_id=p_tenant AND appointment_id=j.id AND application_id=p_application;
  IF FOUND AND p_state IN ('potential','confirmed') AND assignment.conflict NOT IN ('potential','confirmed') THEN
    PERFORM public.assessment_declare_conflict(p_tenant,assignment.id,p_member,p_session_hash,p_csrf_hash,assignment.version,p_state,p_reason);
  END IF;
  INSERT INTO public.awards_audit_event(tenant_id,award_id,actor_kind,actor_id,action,subject_id,reason,changes)
    VALUES(p_tenant,r.award_id,'appointment',j.id,'panel.conflict_declared',c.id,p_reason,jsonb_build_object('state',c.state,'version',c.version));
  RETURN jsonb_build_object('id',c.id,'state',c.state,'version',c.version);
END $$;
CREATE FUNCTION public.assessment_panel_evidence(p_tenant uuid,p_round uuid,p_application uuid,p_member uuid,p_session_hash text,p_page integer DEFAULT 1)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE r public.assessment_round; j public.assessment_appointment; evidence jsonb; messages jsonb; history jsonb; criteria jsonb; moderation uuid;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'Service authority required' USING ERRCODE='42501'; END IF;
  IF p_page IS NULL OR p_page NOT BETWEEN 1 AND 10000 THEN RAISE EXCEPTION 'Invalid page'; END IF;
  SELECT * INTO r FROM public.assessment_round WHERE tenant_id=p_tenant AND id=p_round FOR SHARE;
  j:=public.assessment_panel_authority(p_tenant,p_round,p_member,p_session_hash,NULL,false);
  IF NOT (j.role=ANY(r.moderation_discussion||r.moderation_proposers||r.moderation_approvers))
    OR NOT public.assessment_round_candidate(p_tenant,r.id,p_application)
    OR NOT EXISTS(SELECT 1 FROM public.assessment_panel_conflict WHERE appointment_id=j.id AND application_id=p_application AND state IN ('none','cleared'))
    OR EXISTS(SELECT 1 FROM public.assessment_assignment WHERE appointment_id=j.id AND application_id=p_application AND conflict IN ('potential','confirmed')) THEN
    RAISE EXCEPTION 'Declare or resolve the panel conflict before opening evidence' USING ERRCODE='42501'; END IF;
  evidence:=public.assessment_evidence(p_tenant,r.id,p_application);
  IF evidence->'application'->>'eligibility'<>'eligible' THEN RAISE EXCEPTION 'Application unavailable' USING ERRCODE='42501'; END IF;
  evidence:=jsonb_set(evidence,'{assessments}',coalesce((SELECT jsonb_agg(
    CASE WHEN item->>'state'='submitted' THEN item ELSE item-'answers'-'score' END)
    FROM jsonb_array_elements(evidence->'assessments') item),'[]'));
  IF evidence->'moderation'<>'null'::jsonb THEN
    moderation:=(evidence->'moderation'->>'id')::uuid;
    IF jsonb_typeof(evidence->'moderation'->'revision')='object' THEN
      evidence:=jsonb_set(evidence,'{moderation,revision}',(evidence->'moderation'->'revision')-'actor_id'-'actor_kind'-'actor_identity_keys');
    END IF;
  END IF;
  SELECT coalesce(jsonb_agg(to_jsonb(selected) ORDER BY created_at,id),'[]') INTO messages FROM (
    SELECT id,content,created_at FROM public.assessment_moderation_message WHERE tenant_id=p_tenant AND moderation_id=moderation
      ORDER BY created_at,id LIMIT 50 OFFSET (p_page-1)*50
  ) selected;
  SELECT coalesce(jsonb_agg(to_jsonb(selected) ORDER BY revision DESC),'[]') INTO history FROM (
    SELECT id,revision,action,method,criterion_answers,exact_score,original_average,justification,created_at FROM public.assessment_moderation_revision
      WHERE tenant_id=p_tenant AND moderation_id=moderation ORDER BY revision DESC LIMIT 50 OFFSET (p_page-1)*50
  ) selected;
  SELECT jsonb_build_object('id',cv.id,'definition',cv.definition) INTO criteria FROM public.assessment_criteria_version cv
    WHERE cv.tenant_id=p_tenant AND cv.round_id=r.id AND cv.id=(evidence->'assessments'->0->>'criteriaVersionId')::uuid;
  RETURN jsonb_build_object('evidence',evidence,'messages',messages,'history',history,'criteria',criteria,
    'capabilities',jsonb_build_object('propose',j.role=ANY(r.moderation_proposers),'approve',j.role=ANY(r.moderation_approvers),
      'message',j.role=ANY(r.moderation_discussion),'reopen',j.role=ANY(r.moderation_approvers)));
END $$;
CREATE FUNCTION public.assessment_panel_moderate(p_tenant uuid,p_round uuid,p_application uuid,p_member uuid,p_session_hash text,p_csrf_hash text,
  p_command text,p_version bigint,p_method text,p_answers jsonb,p_score jsonb,p_average jsonb,p_sources uuid[],p_reason text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE r public.assessment_round; j public.assessment_appointment;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'Service authority required' USING ERRCODE='42501'; END IF;
  SELECT * INTO r FROM public.assessment_round WHERE tenant_id=p_tenant AND id=p_round FOR UPDATE;
  PERFORM 1 FROM public.awards_application WHERE tenant_id=p_tenant AND id=p_application AND award_id=r.award_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Round application unavailable' USING ERRCODE='42501'; END IF;
  j:=public.assessment_panel_authority(p_tenant,p_round,p_member,p_session_hash,p_csrf_hash,true);
  IF NOT (CASE p_command WHEN 'propose' THEN j.role=ANY(r.moderation_proposers)
      WHEN 'approve' THEN j.role=ANY(r.moderation_approvers) WHEN 'reopen' THEN j.role=ANY(r.moderation_approvers)
      WHEN 'message' THEN j.role=ANY(r.moderation_discussion) ELSE false END) THEN
    RAISE EXCEPTION 'Panel action not permitted' USING ERRCODE='42501'; END IF;
  PERFORM public.assessment_panel_evidence(p_tenant,p_round,p_application,p_member,p_session_hash,1);
  IF p_command='approve' AND EXISTS(
    SELECT 1 FROM public.assessment_moderation m JOIN LATERAL(
      SELECT actor_identity_keys FROM public.assessment_moderation_revision WHERE moderation_id=m.id ORDER BY revision DESC LIMIT 1
    ) proposal ON true WHERE m.tenant_id=p_tenant AND m.round_id=p_round AND m.application_id=p_application
      AND proposal.actor_identity_keys && public.assessment_actor_keys(p_tenant,'appointment',j.id)
  ) THEN RAISE EXCEPTION 'Self-approval requires the configured policy and authorised administration'; END IF;
  RETURN public.assessment_moderate(p_tenant,p_round,p_application,'appointment',j.id,p_command,p_version,p_method,
    p_answers,p_score,p_average,p_sources,p_reason);
END $$;
REVOKE ALL ON FUNCTION public.assessment_panel_conflict_command(uuid,uuid,uuid,uuid,text,text,bigint,text,text) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.assessment_panel_evidence(uuid,uuid,uuid,uuid,text,integer) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.assessment_panel_moderate(uuid,uuid,uuid,uuid,text,text,text,bigint,text,jsonb,jsonb,jsonb,uuid[],text) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.assessment_panel_conflict_command(uuid,uuid,uuid,uuid,text,text,bigint,text,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.assessment_panel_evidence(uuid,uuid,uuid,uuid,text,integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.assessment_panel_moderate(uuid,uuid,uuid,uuid,text,text,text,bigint,text,jsonb,jsonb,jsonb,uuid[],text) TO service_role;
COMMIT;
