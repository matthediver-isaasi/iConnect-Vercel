BEGIN;
CREATE FUNCTION public.assessment_round_is_ready(p_tenant uuid,p_round uuid,p_moderation boolean DEFAULT false)
RETURNS boolean LANGUAGE plpgsql STABLE SET search_path=pg_catalog,public AS $$
DECLARE r public.assessment_round; application uuid; evidence jsonb; completed integer; required integer;
BEGIN
  SELECT * INTO r FROM public.assessment_round WHERE tenant_id=p_tenant AND id=p_round;
  IF NOT FOUND THEN RETURN false; END IF;
  FOR application IN SELECT a.id FROM public.awards_application a WHERE a.tenant_id=p_tenant AND a.award_id=r.award_id
    AND a.eligibility='eligible' AND public.assessment_round_candidate(p_tenant,p_round,a.id) LOOP
    evidence:=public.assessment_evidence(p_tenant,p_round,application);
    SELECT count(*) FILTER(WHERE item->>'state'='submitted' AND item->'score'<>'null'::jsonb),count(*)
      INTO completed,required FROM jsonb_array_elements(evidence->'assessments') item
      WHERE (item->>'included')::boolean AND NOT (item->>'recused')::boolean;
    IF completed<r.required_judges OR r.require_all AND completed<>required THEN RETURN false; END IF;
    IF p_moderation AND r.moderation_required AND (evidence->'moderation'->>'state' IS DISTINCT FROM 'approved'
      OR evidence->'moderation'->>'authorityValid' IS DISTINCT FROM 'true') THEN RETURN false; END IF;
  END LOOP;
  RETURN true;
END $$;
CREATE FUNCTION public.awards_lifecycle_ready(p_tenant uuid,p_award uuid,p_target text)
RETURNS boolean LANGUAGE plpgsql STABLE SET search_path=pg_catalog,public AS $$
BEGIN
  IF p_target='judging' THEN
    RETURN EXISTS(SELECT 1 FROM public.assessment_round WHERE tenant_id=p_tenant AND award_id=p_award AND state='judging');
  ELSIF p_target IN ('moderation','shortlisting') THEN
    RETURN EXISTS(SELECT 1 FROM public.assessment_round WHERE tenant_id=p_tenant AND award_id=p_award)
      AND NOT EXISTS(SELECT 1 FROM public.assessment_round r WHERE r.tenant_id=p_tenant AND r.award_id=p_award
        AND (r.state NOT IN ('moderation','closed') OR NOT public.assessment_round_is_ready(p_tenant,r.id,p_target='shortlisting')));
  ELSIF p_target IN ('results_approved','completed') THEN
    RETURN EXISTS(SELECT 1 FROM public.awards_outcome_revision WHERE tenant_id=p_tenant AND award_id=p_award AND state='approved')
      AND NOT EXISTS(SELECT 1 FROM public.assessment_round WHERE tenant_id=p_tenant AND award_id=p_award AND state<>'closed')
      AND NOT EXISTS(SELECT 1 FROM public.awards_application a WHERE a.tenant_id=p_tenant AND a.award_id=p_award AND a.eligibility='eligible'
        AND coalesce((SELECT o.state FROM public.awards_outcome_revision o WHERE o.tenant_id=p_tenant AND o.application_id=a.id
          ORDER BY o.revision DESC LIMIT 1),'')<>'approved');
  END IF;
  RETURN false;
END $$;
CREATE FUNCTION public.assessment_round_transition(p_tenant uuid,p_round uuid,p_version bigint,p_target text,
  p_closes_at timestamptz,p_actor_kind text,p_actor uuid,p_reason text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE r public.assessment_round; award uuid;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'Service authority required' USING ERRCODE='42501'; END IF;
  IF p_actor_kind NOT IN ('member','tenant_user') OR p_actor IS NULL OR length(btrim(coalesce(p_reason,'')))=0 THEN RAISE EXCEPTION 'Actor and reason required'; END IF;
  SELECT award_id INTO award FROM public.assessment_round WHERE tenant_id=p_tenant AND id=p_round;
  PERFORM 1 FROM public.awards_competition WHERE tenant_id=p_tenant AND id=award FOR UPDATE;
  SELECT * INTO r FROM public.assessment_round WHERE tenant_id=p_tenant AND id=p_round FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Round unavailable' USING ERRCODE='P0002'; END IF;
  IF r.version IS DISTINCT FROM p_version THEN RAISE EXCEPTION 'Round changed' USING ERRCODE='40001'; END IF;
  IF NOT ((r.state='judging' AND p_target IN ('judging','moderation','closed'))
    OR (r.state='moderation' AND p_target IN ('judging','closed')) OR (r.state='closed' AND p_target='judging')) THEN
    RAISE EXCEPTION 'Unsupported round transition'; END IF;
  PERFORM public.awards_require_active_review(p_tenant,r.award_id);
  IF p_target='judging' AND (coalesce(p_closes_at,r.closes_at)<=clock_timestamp() OR r.opens_at IS NULL
    OR coalesce(p_closes_at,r.closes_at) IS NULL OR coalesce(p_closes_at,r.closes_at)<=r.opens_at) THEN
    RAISE EXCEPTION 'A valid future judging deadline is required'; END IF;
  IF p_target IN ('moderation','closed') AND NOT public.assessment_round_is_ready(p_tenant,r.id,p_target='closed') THEN
    RAISE EXCEPTION 'Required completed assessments or approved moderation are missing'; END IF;
  UPDATE public.assessment_round SET state=p_target,closes_at=coalesce(p_closes_at,closes_at),version=version+1 WHERE id=r.id RETURNING * INTO r;
  INSERT INTO public.awards_audit_event(tenant_id,award_id,actor_kind,actor_id,action,subject_id,reason,changes)
    VALUES(p_tenant,r.award_id,p_actor_kind,p_actor,'round.transitioned',r.id,p_reason,
      jsonb_build_object('state',r.state,'version',r.version,'closes_at',r.closes_at));
  RETURN to_jsonb(r);
END $$;
REVOKE ALL ON FUNCTION public.assessment_round_is_ready(uuid,uuid,boolean) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.awards_lifecycle_ready(uuid,uuid,text) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.assessment_round_transition(uuid,uuid,bigint,text,timestamptz,text,uuid,text) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.assessment_round_transition(uuid,uuid,bigint,text,timestamptz,text,uuid,text) TO service_role;
COMMIT;
