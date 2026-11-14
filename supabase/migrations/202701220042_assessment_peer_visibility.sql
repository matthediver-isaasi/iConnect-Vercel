BEGIN;
CREATE FUNCTION public.assessment_peer_view(p_tenant uuid,p_assignment uuid,p_member uuid,p_session_hash text,p_page integer DEFAULT 1)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE own public.assessment_assignment; appointment public.assessment_appointment; r public.assessment_round;
  authority jsonb; own_state text; rows jsonb; total integer;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'Service authority required' USING ERRCODE='42501'; END IF;
  IF num_nonnulls(p_member,p_session_hash)<>1 OR p_page IS NULL OR p_page NOT BETWEEN 1 AND 10000 THEN
    RAISE EXCEPTION 'Judging authority and page required' USING ERRCODE='42501'; END IF;
  SELECT * INTO own FROM public.assessment_assignment WHERE tenant_id=p_tenant AND id=p_assignment;
  IF NOT FOUND OR own.state<>'assigned' OR own.conflict NOT IN ('none','cleared') THEN RAISE EXCEPTION 'Assignment unavailable' USING ERRCODE='42501'; END IF;
  SELECT * INTO appointment FROM public.assessment_appointment WHERE tenant_id=p_tenant AND id=own.appointment_id;
  IF NOT FOUND OR appointment.state<>'accepted' OR appointment.expires_at<=clock_timestamp() THEN
    RAISE EXCEPTION 'Assignment unavailable' USING ERRCODE='42501'; END IF;
  IF p_member IS NOT NULL THEN
    IF appointment.member_id IS DISTINCT FROM p_member THEN RAISE EXCEPTION 'Assignment unavailable' USING ERRCODE='42501'; END IF;
  ELSE
    authority:=public.assessment_session_authority(p_tenant,p_session_hash);
    IF (authority->>'appointment_id')::uuid IS DISTINCT FROM appointment.id THEN RAISE EXCEPTION 'Assignment unavailable' USING ERRCODE='42501'; END IF;
  END IF;
  IF NOT EXISTS(SELECT 1 FROM public.awards_application WHERE tenant_id=p_tenant AND id=own.application_id AND eligibility='eligible') THEN
    RAISE EXCEPTION 'Application unavailable' USING ERRCODE='42501'; END IF;
  SELECT * INTO r FROM public.assessment_round WHERE tenant_id=p_tenant AND id=own.round_id;
  SELECT state INTO own_state FROM public.assessment_revision WHERE assignment_id=own.id ORDER BY revision DESC LIMIT 1;
  IF r.visibility='blind' OR (r.visibility='after_submit' AND own_state IS DISTINCT FROM 'submitted') THEN
    RETURN jsonb_build_object('visibility',r.visibility,'available',false,'commentsVisible',false,'assessments','[]'::jsonb,'total',0,'page',p_page,'pageSize',50);
  END IF;
  WITH peers AS (
    SELECT s.appointment_id,latest.* FROM public.assessment_assignment s
      JOIN public.assessment_appointment judge ON judge.id=s.appointment_id AND judge.tenant_id=p_tenant
      JOIN LATERAL(SELECT * FROM public.assessment_revision v WHERE v.assignment_id=s.id ORDER BY revision DESC LIMIT 1) latest ON true
      WHERE s.tenant_id=p_tenant AND s.round_id=r.id AND s.application_id=own.application_id AND s.id<>own.id
        AND s.application_version_id=own.application_version_id AND s.criteria_version_id=own.criteria_version_id
        AND s.state='assigned' AND s.included AND s.conflict IN ('none','cleared') AND latest.state='submitted'
  ), selected AS (
    SELECT * FROM peers ORDER BY appointment_id LIMIT 50 OFFSET (p_page-1)*50
  )
  SELECT (SELECT count(*) FROM peers),coalesce(jsonb_agg(jsonb_build_object(
    'judgeAlias','Judge '||upper(substr(encode(sha256(convert_to(r.id::text||':'||appointment_id::text,'UTF8')),'hex'),1,8)),
    'score',exact_score,'submittedAt',submitted_at,
    'answers',(SELECT coalesce(jsonb_object_agg(answer.key,
      CASE WHEN jsonb_typeof(answer.value)='object' THEN
        CASE WHEN r.comments_visible THEN jsonb_build_object('value',answer.value->'value','comment',answer.value->'comment')
          ELSE jsonb_build_object('value',answer.value->'value') END
        ELSE answer.value END),'{}')
      FROM jsonb_each(answers) answer WHERE EXISTS(
        SELECT 1 FROM public.assessment_criteria_version cv,jsonb_array_elements(cv.definition->'criteria') criterion
        WHERE cv.id=own.criteria_version_id AND criterion->>'id'=answer.key
          AND (r.comments_visible OR criterion->>'type'<>'text')))
  ) ORDER BY appointment_id),'[]') INTO total,rows FROM selected;
  RETURN jsonb_build_object('visibility',r.visibility,'available',true,'commentsVisible',r.comments_visible,
    'assessments',rows,'total',total,'page',p_page,'pageSize',50);
END $$;
REVOKE ALL ON FUNCTION public.assessment_peer_view(uuid,uuid,uuid,text,integer) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.assessment_peer_view(uuid,uuid,uuid,text,integer) TO service_role;
COMMIT;
