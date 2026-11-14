BEGIN;
CREATE FUNCTION public.assessment_submitted_history(p_tenant uuid,p_round uuid,p_application uuid,p_page integer DEFAULT 1)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE total integer; rows jsonb;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'Service authority required' USING ERRCODE='42501'; END IF;
  IF p_page IS NULL OR p_page NOT BETWEEN 1 AND 10000 THEN RAISE EXCEPTION 'Invalid history page'; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.assessment_round r JOIN public.awards_application a ON a.award_id=r.award_id AND a.tenant_id=r.tenant_id
    WHERE r.tenant_id=p_tenant AND r.id=p_round AND a.id=p_application) THEN RAISE EXCEPTION 'Round application unavailable' USING ERRCODE='42501'; END IF;
  SELECT count(*) INTO total FROM public.assessment_revision revision JOIN public.assessment_assignment assignment ON assignment.id=revision.assignment_id
    WHERE revision.tenant_id=p_tenant AND assignment.round_id=p_round AND assignment.application_id=p_application AND revision.state='submitted';
  SELECT coalesce(jsonb_agg(row ORDER BY submitted_at DESC,id),'[]') INTO rows FROM (
    SELECT revision.id,revision.submitted_at,jsonb_build_object('id',revision.id,
      'judge','Judge '||upper(substr(encode(sha256(convert_to(p_round::text||':'||assignment.appointment_id::text,'UTF8')),'hex'),1,8)),
      'revision',revision.revision,'submittedAt',revision.submitted_at,'answers',revision.answers,'score',revision.exact_score,
      'applicationVersionId',revision.application_version_id,'criteriaVersionId',revision.criteria_version_id,
      'definition',criteria.definition,'current',NOT EXISTS(SELECT 1 FROM public.assessment_revision newer WHERE newer.assignment_id=assignment.id AND newer.revision>revision.revision),
      'assignmentIncluded',assignment.included,'assignmentState',assignment.state,'conflict',assignment.conflict) row
    FROM public.assessment_revision revision JOIN public.assessment_assignment assignment ON assignment.id=revision.assignment_id
    LEFT JOIN public.assessment_criteria_version criteria ON criteria.id=revision.criteria_version_id AND criteria.tenant_id=revision.tenant_id
    WHERE revision.tenant_id=p_tenant AND assignment.round_id=p_round AND assignment.application_id=p_application AND revision.state='submitted'
    ORDER BY revision.submitted_at DESC,revision.id LIMIT 10 OFFSET (p_page-1)*10
  ) selected;
  RETURN jsonb_build_object('assessments',rows,'total',total,'page',p_page,'pageSize',10);
END $$;
REVOKE ALL ON FUNCTION public.assessment_submitted_history(uuid,uuid,uuid,integer) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.assessment_submitted_history(uuid,uuid,uuid,integer) TO service_role;
COMMIT;
