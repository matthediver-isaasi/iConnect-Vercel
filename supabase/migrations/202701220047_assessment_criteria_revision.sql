BEGIN;
CREATE FUNCTION public.assessment_revise_criteria(p_tenant uuid,p_round uuid,p_version bigint,p_definition jsonb,p_deadline timestamptz,
  p_actor_kind text,p_actor uuid,p_reason text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE r public.assessment_round; criteria uuid; next_version integer; assignment public.assessment_assignment; revision_number integer; affected integer:=0;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'Service authority required' USING ERRCODE='42501'; END IF;
  IF p_actor_kind NOT IN ('member','tenant_user') OR p_actor IS NULL OR length(btrim(coalesce(p_reason,'')))=0
    OR jsonb_typeof(p_definition) IS DISTINCT FROM 'object' OR p_deadline IS NULL OR p_deadline<=clock_timestamp() THEN
    RAISE EXCEPTION 'Validated criteria, a future deadline and revision reason required'; END IF;
  SELECT * INTO r FROM public.assessment_round WHERE tenant_id=p_tenant AND id=p_round;
  IF NOT FOUND THEN RAISE EXCEPTION 'Round unavailable'; END IF;
  PERFORM 1 FROM public.awards_competition WHERE tenant_id=p_tenant AND id=r.award_id FOR UPDATE;
  SELECT * INTO r FROM public.assessment_round WHERE tenant_id=p_tenant AND id=p_round FOR UPDATE;
  IF r.version IS DISTINCT FROM p_version THEN RAISE EXCEPTION 'Round changed' USING ERRCODE='40001'; END IF;
  PERFORM public.awards_require_active_review(p_tenant,r.award_id);
  IF r.opens_at IS NOT NULL AND p_deadline<=r.opens_at THEN RAISE EXCEPTION 'Deadline must follow round opening'; END IF;
  IF r.state NOT IN ('draft','judging','moderation') THEN RAISE EXCEPTION 'Reopen the round before revising criteria'; END IF;
  IF EXISTS(SELECT 1 FROM public.awards_application a WHERE a.tenant_id=p_tenant AND a.award_id=r.award_id
    AND public.assessment_round_candidate(p_tenant,r.id,a.id) AND public.assessment_has_active_decisions(p_tenant,r.id,a.id)) THEN
    RAISE EXCEPTION 'Reopen downstream decisions before revising criteria'; END IF;
  IF EXISTS(SELECT 1 FROM public.assessment_revision ar JOIN public.assessment_assignment s ON s.id=ar.assignment_id
    WHERE s.tenant_id=p_tenant AND s.round_id=r.id AND (ar.application_version_id IS NULL OR ar.criteria_version_id IS NULL)) THEN
    RAISE EXCEPTION 'Historical provenance requires an authorised migration before criteria revision'; END IF;
  SELECT coalesce(max(revision),0)+1 INTO next_version FROM public.assessment_criteria_version WHERE round_id=r.id;
  INSERT INTO public.assessment_criteria_version(tenant_id,round_id,revision,definition)
    VALUES(p_tenant,r.id,next_version,p_definition) RETURNING id INTO criteria;
  FOR assignment IN SELECT * FROM public.assessment_assignment WHERE tenant_id=p_tenant AND round_id=r.id ORDER BY id FOR UPDATE LOOP
    UPDATE public.assessment_assignment SET criteria_version_id=criteria,version=version+1 WHERE id=assignment.id;
    SELECT coalesce(max(revision),0)+1 INTO revision_number FROM public.assessment_revision WHERE assignment_id=assignment.id;
    INSERT INTO public.assessment_revision(tenant_id,assignment_id,revision,state,answers)
      VALUES(p_tenant,assignment.id,revision_number,'reopened','{}');
    affected:=affected+1;
  END LOOP;
  UPDATE public.assessment_round SET state=CASE WHEN state='draft' THEN 'draft' ELSE 'judging' END,
    closes_at=p_deadline,version=version+1 WHERE id=r.id RETURNING * INTO r;
  INSERT INTO public.awards_audit_event(tenant_id,award_id,actor_kind,actor_id,action,subject_id,reason,changes)
    VALUES(p_tenant,r.award_id,p_actor_kind,p_actor,'round.criteria_revised',r.id,p_reason,
      jsonb_build_object('criteria_version_id',criteria,'revision',next_version,'affected_assignments',affected,'deadline',p_deadline));
  RETURN jsonb_build_object('round',to_jsonb(r),'criteriaVersionId',criteria,'affectedAssignments',affected);
END $$;
REVOKE ALL ON FUNCTION public.assessment_revise_criteria(uuid,uuid,bigint,jsonb,timestamptz,text,uuid,text) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.assessment_revise_criteria(uuid,uuid,bigint,jsonb,timestamptz,text,uuid,text) TO service_role;
COMMIT;
