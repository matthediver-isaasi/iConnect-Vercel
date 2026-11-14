BEGIN;
CREATE FUNCTION public.assessment_evidence(p_tenant uuid,p_round uuid,p_application uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE r public.assessment_round; a public.awards_application; rows jsonb; moderation jsonb;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'Service authority required' USING ERRCODE='42501'; END IF;
  SELECT * INTO r FROM public.assessment_round WHERE tenant_id=p_tenant AND id=p_round;
  SELECT * INTO a FROM public.awards_application WHERE tenant_id=p_tenant AND id=p_application AND award_id=r.award_id;
  IF a.id IS NULL OR r.id IS NULL THEN RAISE EXCEPTION 'Round application unavailable' USING ERRCODE='P0002'; END IF;
  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'assignmentId',s.id,'appointmentId',j.id,'included',s.included,
    'recused',s.state<>'assigned' OR s.conflict NOT IN ('none','cleared') OR a.eligibility<>'eligible',
    'applicationVersionId',s.application_version_id,'criteriaVersionId',s.criteria_version_id,
    'revisionId',latest.id,'state',latest.state,'revision',latest.revision,
    'score',latest.exact_score,'answers',latest.answers
  ) ORDER BY s.id),'[]') INTO rows
  FROM public.assessment_assignment s
    JOIN public.assessment_appointment j ON j.id=s.appointment_id AND j.tenant_id=p_tenant
    LEFT JOIN LATERAL (SELECT * FROM public.assessment_revision x
      WHERE x.tenant_id=p_tenant AND x.assignment_id=s.id ORDER BY revision DESC LIMIT 1) latest ON true
    WHERE s.tenant_id=p_tenant AND s.round_id=p_round AND s.application_id=p_application;
  SELECT jsonb_build_object('id',m.id,'state',m.state,'version',m.version,'revision',to_jsonb(latest),
    'authorityValid',NOT EXISTS(SELECT 1 FROM (
      SELECT actor_identity_keys FROM public.assessment_moderation_revision
        WHERE moderation_id=m.id ORDER BY revision DESC LIMIT 2
    ) actors WHERE cardinality(actor_identity_keys)=0 OR public.assessment_actor_conflicted(p_tenant,p_round,p_application,actor_identity_keys))) INTO moderation
    FROM public.assessment_moderation m
    LEFT JOIN LATERAL (SELECT * FROM public.assessment_moderation_revision x
      WHERE x.tenant_id=p_tenant AND x.moderation_id=m.id ORDER BY revision DESC LIMIT 1) latest ON true
    WHERE m.tenant_id=p_tenant AND m.round_id=p_round AND m.application_id=p_application;
  RETURN jsonb_build_object('round',to_jsonb(r),'application',jsonb_build_object('id',a.id,'reference',a.reference,'eligibility',a.eligibility),
    'assessments',rows,'moderation',moderation,'shortlist',
    (SELECT jsonb_build_object('id',s.id,'revision',s.revision,'state',s.state,'reason',s.reason)
      FROM public.assessment_shortlist_decision s WHERE s.tenant_id=p_tenant AND s.round_id=p_round
      AND s.application_id=p_application ORDER BY s.revision DESC LIMIT 1));
END $$;
REVOKE ALL ON FUNCTION public.assessment_evidence(uuid,uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.assessment_evidence(uuid,uuid,uuid) TO service_role;

CREATE FUNCTION public.assessment_moderate(
  p_tenant uuid,p_round uuid,p_application uuid,p_actor_kind text,p_actor uuid,
  p_command text,p_expected_version bigint,p_method text,p_answers jsonb,p_score jsonb,p_average jsonb,
  p_source_revisions uuid[],p_reason text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE r public.assessment_round; a public.awards_application; m public.assessment_moderation;
  previous public.assessment_moderation_revision; next_revision integer; current_sources uuid[];
  criteria uuid; snapshot uuid; evidence jsonb;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'Service authority required' USING ERRCODE='42501'; END IF;
  IF p_actor_kind NOT IN ('member','tenant_user','appointment') OR p_actor IS NULL OR p_command NOT IN ('message','propose','approve','reopen')
    OR length(btrim(coalesce(p_reason,'')))=0 OR length(p_reason)>20000 THEN RAISE EXCEPTION 'Moderation actor, command and justification required'; END IF;
  SELECT * INTO r FROM public.assessment_round WHERE tenant_id=p_tenant AND id=p_round FOR UPDATE;
  IF NOT FOUND OR r.state NOT IN ('judging','moderation') THEN RAISE EXCEPTION 'Round is not available for moderation'; END IF;
  PERFORM public.awards_require_active_review(p_tenant,r.award_id);
  SELECT * INTO a FROM public.awards_application WHERE tenant_id=p_tenant AND id=p_application AND award_id=r.award_id FOR UPDATE;
  IF NOT FOUND OR a.eligibility<>'eligible' THEN RAISE EXCEPTION 'Application is not eligible'; END IF;
  IF public.assessment_actor_conflicted(p_tenant,r.id,a.id,public.assessment_actor_keys(p_tenant,p_actor_kind,p_actor)) THEN
    RAISE EXCEPTION 'Resolve your declared conflict before participating in moderation'; END IF;
  SELECT * INTO m FROM public.assessment_moderation WHERE tenant_id=p_tenant AND round_id=r.id AND application_id=a.id FOR UPDATE;
  IF NOT FOUND THEN
    IF p_expected_version IS DISTINCT FROM 0 THEN RAISE EXCEPTION 'Moderation changed' USING ERRCODE='40001'; END IF;
    SELECT s.application_version_id,s.criteria_version_id INTO snapshot,criteria FROM public.assessment_assignment s
      WHERE s.tenant_id=p_tenant AND s.round_id=r.id AND s.application_id=a.id AND s.state='assigned' LIMIT 1;
    IF snapshot IS NULL OR EXISTS(SELECT 1 FROM public.assessment_assignment s
      WHERE s.tenant_id=p_tenant AND s.round_id=r.id AND s.application_id=a.id AND s.state='assigned'
      AND (s.application_version_id<>snapshot OR s.criteria_version_id<>criteria)) THEN RAISE EXCEPTION 'Consistent review versions required'; END IF;
    INSERT INTO public.assessment_moderation(tenant_id,award_id,round_id,application_id,application_version_id,criteria_version_id)
      VALUES(p_tenant,r.award_id,r.id,a.id,snapshot,criteria) RETURNING * INTO m;
  ELSIF m.version IS DISTINCT FROM p_expected_version THEN RAISE EXCEPTION 'Moderation changed' USING ERRCODE='40001';
  END IF;
  IF m.state='reopened' AND p_command='propose' THEN
    SELECT application_version_id,criteria_version_id INTO snapshot,criteria FROM public.assessment_assignment
      WHERE tenant_id=p_tenant AND round_id=r.id AND application_id=a.id AND state='assigned' LIMIT 1;
    IF snapshot IS NULL OR EXISTS(SELECT 1 FROM public.assessment_assignment
      WHERE tenant_id=p_tenant AND round_id=r.id AND application_id=a.id AND state='assigned'
        AND (application_version_id<>snapshot OR criteria_version_id<>criteria)) THEN
      RAISE EXCEPTION 'Consistent review versions required'; END IF;
    UPDATE public.assessment_moderation SET application_version_id=snapshot,criteria_version_id=criteria WHERE id=m.id RETURNING * INTO m;
  END IF;
  IF p_command='message' THEN
    INSERT INTO public.assessment_moderation_message(tenant_id,moderation_id,actor_kind,actor_id,content)
      VALUES(p_tenant,m.id,p_actor_kind,p_actor,p_reason);
  ELSE
    IF coalesce((SELECT state IN ('recommended','confirmed') FROM public.assessment_shortlist_decision WHERE tenant_id=p_tenant AND round_id=r.id AND application_id=a.id ORDER BY revision DESC LIMIT 1),false)
      OR coalesce((SELECT state<>'reopened' FROM public.awards_outcome_revision WHERE tenant_id=p_tenant AND application_id=a.id ORDER BY revision DESC LIMIT 1),false) THEN
      RAISE EXCEPTION 'Review downstream decisions before changing moderation'; END IF;
    IF p_command='reopen' THEN
      SELECT * INTO previous FROM public.assessment_moderation_revision WHERE moderation_id=m.id ORDER BY revision DESC LIMIT 1;
      IF m.state NOT IN ('proposed','approved') OR previous.id IS NULL THEN RAISE EXCEPTION 'Invalid moderation transition'; END IF;
      INSERT INTO public.assessment_moderation_revision(tenant_id,moderation_id,revision,action,method,criterion_answers,
        exact_score,original_average,assessment_revision_ids,justification,actor_kind,actor_id)
        VALUES(p_tenant,m.id,previous.revision+1,'reopened',previous.method,previous.criterion_answers,
          previous.exact_score,previous.original_average,previous.assessment_revision_ids,p_reason,p_actor_kind,p_actor);
      UPDATE public.assessment_moderation SET state='reopened',version=version+1 WHERE id=m.id RETURNING * INTO m;
      INSERT INTO public.awards_audit_event(tenant_id,award_id,actor_kind,actor_id,action,subject_id,reason,changes)
        VALUES(p_tenant,r.award_id,p_actor_kind,p_actor,'moderation.reopen',m.id,p_reason,jsonb_build_object('state',m.state,'version',m.version));
      RETURN jsonb_build_object('id',m.id,'state',m.state,'version',m.version);
    END IF;
    evidence:=public.assessment_evidence(p_tenant,r.id,a.id);
    SELECT array_agg((item->>'revisionId')::uuid ORDER BY item->>'revisionId') INTO current_sources
      FROM jsonb_array_elements(evidence->'assessments') item
      WHERE item->>'state'='submitted' AND (item->>'included')::boolean AND NOT (item->>'recused')::boolean
        AND item->'score'<>'null'::jsonb;
    IF current_sources IS NULL OR cardinality(current_sources)<r.required_judges OR current_sources IS DISTINCT FROM
      (SELECT array_agg(v ORDER BY v::text) FROM unnest(p_source_revisions) v) THEN
      RAISE EXCEPTION 'Assessment evidence changed or is incomplete' USING ERRCODE='40001'; END IF;
    IF r.require_all AND cardinality(current_sources)<>(SELECT count(*) FROM jsonb_array_elements(evidence->'assessments') item
      WHERE (item->>'included')::boolean AND NOT (item->>'recused')::boolean) THEN
      RAISE EXCEPTION 'All required assessments must be complete'; END IF;
    SELECT * INTO previous FROM public.assessment_moderation_revision WHERE moderation_id=m.id ORDER BY revision DESC LIMIT 1;
    next_revision:=coalesce(previous.revision,0)+1;
    IF p_command='propose' THEN
      IF m.state='approved' THEN RAISE EXCEPTION 'Reopen approved moderation before proposing changes'; END IF;
      IF p_method NOT IN ('criterion','overall') OR p_score IS NULL OR p_average IS NULL THEN RAISE EXCEPTION 'Validated scores required'; END IF;
      INSERT INTO public.assessment_moderation_revision(tenant_id,moderation_id,revision,action,method,criterion_answers,
        exact_score,original_average,assessment_revision_ids,justification,actor_kind,actor_id)
        VALUES(p_tenant,m.id,next_revision,'proposed',p_method,p_answers,p_score,p_average,current_sources,p_reason,p_actor_kind,p_actor);
      UPDATE public.assessment_moderation SET state='proposed',version=version+1 WHERE id=m.id RETURNING * INTO m;
    ELSE
      IF (p_command='approve' AND (m.state<>'proposed' OR previous.action<>'proposed'))
        OR (p_command='reopen' AND m.state<>'approved') THEN RAISE EXCEPTION 'Invalid moderation transition'; END IF;
      IF p_command='approve' AND NOT r.self_approval AND
        (previous.actor_kind=p_actor_kind AND previous.actor_id=p_actor OR
          previous.actor_identity_keys && public.assessment_actor_keys(p_tenant,p_actor_kind,p_actor)) THEN
        RAISE EXCEPTION 'A separate approver is required'; END IF;
      IF previous.assessment_revision_ids IS DISTINCT FROM current_sources THEN RAISE EXCEPTION 'Proposal evidence changed' USING ERRCODE='40001'; END IF;
      IF p_command='approve' AND public.assessment_actor_conflicted(p_tenant,r.id,a.id,previous.actor_identity_keys) THEN
        RAISE EXCEPTION 'The proposer has an unresolved conflict'; END IF;
      INSERT INTO public.assessment_moderation_revision(tenant_id,moderation_id,revision,action,method,criterion_answers,
        exact_score,original_average,assessment_revision_ids,justification,actor_kind,actor_id)
        VALUES(p_tenant,m.id,next_revision,CASE WHEN p_command='approve' THEN 'approved' ELSE 'reopened' END,
          previous.method,previous.criterion_answers,previous.exact_score,previous.original_average,current_sources,p_reason,p_actor_kind,p_actor);
      UPDATE public.assessment_moderation SET state=CASE WHEN p_command='approve' THEN 'approved' ELSE 'reopened' END,
        version=version+1 WHERE id=m.id RETURNING * INTO m;
    END IF;
  END IF;
  INSERT INTO public.awards_audit_event(tenant_id,award_id,actor_kind,actor_id,action,subject_id,reason,changes)
    VALUES(p_tenant,r.award_id,p_actor_kind,p_actor,'moderation.'||p_command,m.id,
      CASE WHEN p_command='message' THEN NULL ELSE p_reason END,jsonb_build_object('state',m.state,'version',m.version));
  RETURN jsonb_build_object('id',m.id,'state',m.state,'version',m.version);
END $$;
REVOKE ALL ON FUNCTION public.assessment_moderate(uuid,uuid,uuid,text,uuid,text,bigint,text,jsonb,jsonb,jsonb,uuid[],text)
  FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.assessment_moderate(uuid,uuid,uuid,text,uuid,text,bigint,text,jsonb,jsonb,jsonb,uuid[],text) TO service_role;
COMMIT;
