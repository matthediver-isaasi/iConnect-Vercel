BEGIN;
ALTER TABLE public.assessment_revision ADD COLUMN request_id uuid;
CREATE UNIQUE INDEX assessment_revision_request ON public.assessment_revision(assignment_id,request_id) WHERE request_id IS NOT NULL;

CREATE FUNCTION public.assessment_record_revision(
  p_tenant uuid,p_assignment uuid,p_member uuid,p_session_hash text,p_csrf_hash text,
  p_expected_revision integer,p_request_id uuid,p_submit boolean,p_answers jsonb,
  p_exact_score jsonb,p_criteria_version uuid,p_application_version uuid
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE link public.assessment_assignment; appointment public.assessment_appointment;
  round_record public.assessment_round; application public.awards_application;
  previous public.assessment_revision; recorded public.assessment_revision;
  credential public.assessment_session; actor_kind text; actor uuid;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'Service authority required' USING ERRCODE='42501'; END IF;
  IF p_request_id IS NULL OR p_submit IS NULL OR p_expected_revision IS NULL OR p_expected_revision<0
    OR jsonb_typeof(p_answers) IS DISTINCT FROM 'object'
    OR pg_column_size(p_answers)>2000000 OR num_nonnulls(p_member,p_session_hash)<>1 THEN RAISE EXCEPTION 'Invalid assessment request'; END IF;
  SELECT * INTO link FROM public.assessment_assignment WHERE tenant_id=p_tenant AND id=p_assignment;
  IF NOT FOUND THEN RAISE EXCEPTION 'Assignment unavailable' USING ERRCODE='42501'; END IF;
  -- All state-changing assessment operations must use this order:
  -- round -> application -> appointment -> assignment -> revision.
  SELECT * INTO round_record FROM public.assessment_round WHERE tenant_id=p_tenant AND id=link.round_id FOR UPDATE;
  SELECT * INTO application FROM public.awards_application WHERE tenant_id=p_tenant AND id=link.application_id FOR UPDATE;
  SELECT * INTO appointment FROM public.assessment_appointment WHERE tenant_id=p_tenant AND id=link.appointment_id FOR UPDATE;
  SELECT * INTO link FROM public.assessment_assignment WHERE tenant_id=p_tenant AND id=p_assignment FOR UPDATE;
  IF p_member IS NOT NULL THEN
    IF appointment.member_id IS DISTINCT FROM p_member THEN RAISE EXCEPTION 'Assignment unavailable' USING ERRCODE='42501'; END IF;
    actor_kind:='member';actor:=p_member;
  ELSE
    SELECT * INTO credential FROM public.assessment_session
      WHERE tenant_id=p_tenant AND token_hash=p_session_hash AND appointment_id=appointment.id;
    IF NOT FOUND OR credential.revoked_at IS NOT NULL OR credential.expires_at<=clock_timestamp()
      OR credential.generation<>appointment.credential_generation OR credential.csrf_hash IS DISTINCT FROM p_csrf_hash
      OR appointment.member_id IS NOT NULL THEN RAISE EXCEPTION 'Judging session unavailable' USING ERRCODE='42501'; END IF;
    actor_kind:='appointment';actor:=appointment.id;
  END IF;
  IF appointment.state<>'accepted' OR appointment.expires_at<=clock_timestamp() THEN
    RAISE EXCEPTION 'Appointment unavailable' USING ERRCODE='42501'; END IF;
  SELECT * INTO recorded FROM public.assessment_revision WHERE assignment_id=link.id AND request_id=p_request_id;
  IF FOUND THEN
    IF recorded.answers IS DISTINCT FROM p_answers OR recorded.exact_score IS DISTINCT FROM p_exact_score
      OR (recorded.state='submitted') IS DISTINCT FROM p_submit
      OR p_criteria_version IS DISTINCT FROM link.criteria_version_id OR p_application_version IS DISTINCT FROM link.application_version_id THEN
      RAISE EXCEPTION 'Request key was used for different assessment content' USING ERRCODE='23505';
    END IF;
    RETURN jsonb_build_object('id',recorded.id,'revision',recorded.revision,'state',recorded.state,'replayed',true);
  END IF;
  IF p_submit AND public.assessment_has_active_decisions(p_tenant,link.round_id,link.application_id) THEN
    RAISE EXCEPTION 'Reopen dependent decisions before accepting another final assessment'; END IF;
  PERFORM public.awards_require_active_review(p_tenant,link.award_id);
  IF round_record.state<>'judging' OR round_record.opens_at IS NULL OR round_record.closes_at IS NULL
    OR clock_timestamp()<round_record.opens_at OR clock_timestamp()>=round_record.closes_at
    OR application.eligibility<>'eligible' OR link.state<>'assigned'
    OR link.conflict NOT IN ('none','cleared') OR appointment.role NOT IN ('judge','chair') THEN
    RAISE EXCEPTION 'Assessment is not currently available' USING ERRCODE='42501';
  END IF;
  IF p_criteria_version IS DISTINCT FROM link.criteria_version_id OR p_application_version IS DISTINCT FROM link.application_version_id THEN
    RAISE EXCEPTION 'Review version changed' USING ERRCODE='40001'; END IF;
  SELECT * INTO previous FROM public.assessment_revision WHERE assignment_id=link.id ORDER BY revision DESC LIMIT 1;
  IF coalesce(previous.revision,0)<>p_expected_revision THEN RAISE EXCEPTION 'Assessment changed; reload before saving' USING ERRCODE='40001'; END IF;
  IF previous.state IN ('submitted','recused') THEN RAISE EXCEPTION 'Assessment is locked'; END IF;
  -- Requiredness and score calculation are performed by the server using the
  -- exact assigned immutable criteria version. This RPC is not browser callable.
  IF p_exact_score IS NOT NULL AND (jsonb_typeof(p_exact_score)<>'object'
    OR coalesce(p_exact_score->>'numerator','') !~ '^[0-9]+$'
    OR length(p_exact_score->>'numerator')>1000
    OR coalesce(p_exact_score->>'denominator','') !~ '^[1-9][0-9]*$'
    OR length(p_exact_score->>'denominator')>1000) THEN RAISE EXCEPTION 'Invalid exact score'; END IF;
  IF p_exact_score IS NOT NULL AND (p_exact_score->>'numerator')::numeric
    >100*(p_exact_score->>'denominator')::numeric THEN RAISE EXCEPTION 'Score outside range'; END IF;
  INSERT INTO public.assessment_revision(tenant_id,assignment_id,revision,state,answers,exact_score,submitted_at,request_id)
    VALUES(p_tenant,link.id,p_expected_revision+1,CASE WHEN p_submit THEN 'submitted' ELSE 'draft' END,
      p_answers,p_exact_score,CASE WHEN p_submit THEN clock_timestamp() ELSE NULL END,p_request_id) RETURNING * INTO recorded;
  INSERT INTO public.awards_audit_event(tenant_id,award_id,actor_kind,actor_id,action,subject_id,changes)
    VALUES(p_tenant,link.award_id,actor_kind,actor,CASE WHEN p_submit THEN 'assessment.submitted' ELSE 'assessment.draft_saved' END,
      link.id,jsonb_build_object('revision_id',recorded.id,'revision',recorded.revision));
  RETURN jsonb_build_object('id',recorded.id,'revision',recorded.revision,'state',recorded.state,'replayed',false);
END $$;

CREATE FUNCTION public.assessment_reopen(
  p_tenant uuid,p_assignment uuid,p_expected_revision integer,p_actor_kind text,p_actor uuid,p_reason text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE link public.assessment_assignment; previous public.assessment_revision; recorded public.assessment_revision;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'Service authority required' USING ERRCODE='42501'; END IF;
  IF p_actor_kind NOT IN ('member','tenant_user') OR p_actor IS NULL OR length(btrim(coalesce(p_reason,'')))=0 THEN RAISE EXCEPTION 'Actor and reason required'; END IF;
  SELECT * INTO link FROM public.assessment_assignment WHERE tenant_id=p_tenant AND id=p_assignment;
  IF NOT FOUND THEN RAISE EXCEPTION 'Assignment unavailable' USING ERRCODE='P0002'; END IF;
  PERFORM public.awards_require_active_review(p_tenant,link.award_id);
  PERFORM 1 FROM public.assessment_round WHERE tenant_id=p_tenant AND id=link.round_id FOR UPDATE;
  PERFORM 1 FROM public.awards_application WHERE tenant_id=p_tenant AND id=link.application_id FOR UPDATE;
  PERFORM 1 FROM public.assessment_appointment WHERE tenant_id=p_tenant AND id=link.appointment_id FOR UPDATE;
  PERFORM 1 FROM public.assessment_assignment WHERE tenant_id=p_tenant AND id=link.id FOR UPDATE;
  -- Downstream invalidation requires its own coordinated decision command.
  -- Reopening is permitted only after active downstream decisions are reopened.
  IF public.assessment_has_active_decisions(p_tenant,link.round_id,link.application_id) THEN
    RAISE EXCEPTION 'Reopen downstream decisions before reopening this assessment';
  END IF;
  SELECT * INTO previous FROM public.assessment_revision WHERE assignment_id=link.id ORDER BY revision DESC LIMIT 1;
  IF previous.revision IS DISTINCT FROM p_expected_revision THEN RAISE EXCEPTION 'Assessment changed' USING ERRCODE='40001'; END IF;
  IF previous.state IS DISTINCT FROM 'submitted' THEN RAISE EXCEPTION 'Only submitted assessments can be reopened'; END IF;
  INSERT INTO public.assessment_revision(tenant_id,assignment_id,revision,state,answers,exact_score)
    VALUES(p_tenant,link.id,previous.revision+1,'reopened',previous.answers,NULL) RETURNING * INTO recorded;
  INSERT INTO public.awards_audit_event(tenant_id,award_id,actor_kind,actor_id,action,subject_id,reason,changes)
    VALUES(p_tenant,link.award_id,p_actor_kind,p_actor,'assessment.reopened',link.id,p_reason,
      jsonb_build_object('previous_revision_id',previous.id,'revision_id',recorded.id));
  RETURN jsonb_build_object('id',recorded.id,'revision',recorded.revision,'state',recorded.state);
END $$;
REVOKE ALL ON FUNCTION public.assessment_record_revision(uuid,uuid,uuid,text,text,integer,uuid,boolean,jsonb,jsonb,uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.assessment_reopen(uuid,uuid,integer,text,uuid,text) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.assessment_record_revision(uuid,uuid,uuid,text,text,integer,uuid,boolean,jsonb,jsonb,uuid,uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.assessment_reopen(uuid,uuid,integer,text,uuid,text) TO service_role;
COMMIT;
