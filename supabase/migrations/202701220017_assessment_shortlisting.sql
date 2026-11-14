BEGIN;
ALTER TABLE public.assessment_shortlist_decision ADD COLUMN source_fingerprint text;
ALTER TABLE public.assessment_shortlist_decision ADD COLUMN selection_mode text;
ALTER TABLE public.assessment_shortlist_decision ADD COLUMN score_snapshot jsonb;
ALTER TABLE public.assessment_shortlist_decision ADD COLUMN is_override boolean NOT NULL DEFAULT false;
CREATE FUNCTION public.assessment_round_evidence(p_tenant uuid,p_round uuid,p_page integer DEFAULT 1)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE r public.assessment_round; rows jsonb; total integer;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'Service authority required' USING ERRCODE='42501'; END IF;
  IF p_page IS NULL OR p_page<1 OR p_page>10000 THEN RAISE EXCEPTION 'Invalid page'; END IF;
  SELECT * INTO r FROM public.assessment_round WHERE tenant_id=p_tenant AND id=p_round;
  IF NOT FOUND THEN RAISE EXCEPTION 'Round unavailable' USING ERRCODE='P0002'; END IF;
  SELECT count(*) INTO total FROM public.awards_application WHERE tenant_id=p_tenant AND award_id=r.award_id AND public.assessment_round_candidate(p_tenant,r.id,id);
  SELECT coalesce(jsonb_agg(jsonb_build_object('evidence',evidence,'fingerprint',public.assessment_fingerprint(evidence)) ORDER BY id),'[]') INTO rows
    FROM (SELECT a.id,public.assessment_evidence(p_tenant,p_round,a.id) evidence
      FROM public.awards_application a WHERE a.tenant_id=p_tenant AND a.award_id=r.award_id AND public.assessment_round_candidate(p_tenant,r.id,a.id)
      ORDER BY a.id LIMIT 50 OFFSET (p_page-1)*50) entries;
  RETURN jsonb_build_object('round',to_jsonb(r),'entries',rows,'total',total,'page',p_page,'pageSize',50);
END $$;
CREATE FUNCTION public.assessment_record_shortlist(p_tenant uuid,p_round uuid,p_actor_kind text,p_actor uuid,
  p_mode text,p_decisions jsonb,p_fingerprints jsonb,p_reason text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE r public.assessment_round; decision jsonb; application public.awards_application;
  fingerprint text; next_revision integer; saved_ids uuid[]:='{}'; saved uuid; previous_state text; award uuid;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'Service authority required' USING ERRCODE='42501'; END IF;
  IF p_actor_kind NOT IN ('member','tenant_user') OR p_actor IS NULL
    OR p_mode NOT IN ('threshold','top_ranked','manual','threshold_approval')
    OR jsonb_typeof(p_decisions) IS DISTINCT FROM 'array' OR jsonb_array_length(p_decisions)>500
    OR jsonb_typeof(p_fingerprints) IS DISTINCT FROM 'object'
    OR length(btrim(coalesce(p_reason,'')))=0 THEN RAISE EXCEPTION 'Validated shortlist decisions and reason required'; END IF;
  SELECT award_id INTO award FROM public.assessment_round WHERE tenant_id=p_tenant AND id=p_round;
  PERFORM 1 FROM public.awards_competition WHERE tenant_id=p_tenant AND id=award FOR UPDATE;
  SELECT * INTO r FROM public.assessment_round WHERE tenant_id=p_tenant AND id=p_round FOR UPDATE;
  IF NOT FOUND OR r.state NOT IN ('judging','moderation','closed') THEN RAISE EXCEPTION 'Round not ready for shortlisting'; END IF;
  IF (SELECT count(*) FROM public.awards_application WHERE tenant_id=p_tenant AND award_id=r.award_id AND public.assessment_round_candidate(p_tenant,r.id,id))
    <> (SELECT count(*) FROM jsonb_object_keys(p_fingerprints)) THEN
    RAISE EXCEPTION 'Application set changed; preview again' USING ERRCODE='40001'; END IF;
  FOR application IN SELECT * FROM public.awards_application WHERE tenant_id=p_tenant AND award_id=r.award_id
    AND public.assessment_round_candidate(p_tenant,r.id,id) ORDER BY id FOR UPDATE LOOP
    fingerprint:=public.assessment_fingerprint(public.assessment_evidence(p_tenant,r.id,application.id));
    IF fingerprint IS DISTINCT FROM p_fingerprints->>application.id::text THEN
      RAISE EXCEPTION 'Judging evidence changed; preview again' USING ERRCODE='40001'; END IF;
  END LOOP;
  IF (SELECT count(DISTINCT d->>'applicationId') FROM jsonb_array_elements(p_decisions) d)<>jsonb_array_length(p_decisions) THEN
    RAISE EXCEPTION 'Duplicate shortlist decisions'; END IF;
  FOR decision IN SELECT value FROM jsonb_array_elements(p_decisions) LOOP
    SELECT * INTO application FROM public.awards_application WHERE tenant_id=p_tenant AND award_id=r.award_id AND id=(decision->>'applicationId')::uuid;
    IF NOT FOUND OR NOT public.assessment_round_candidate(p_tenant,r.id,application.id)
      OR application.eligibility<>'eligible' OR decision->>'state' NOT IN ('recommended','confirmed','rejected','reopened') THEN
      RAISE EXCEPTION 'Application or shortlist state unavailable'; END IF;
    IF coalesce((SELECT state<>'reopened' FROM public.awards_outcome_revision WHERE tenant_id=p_tenant AND application_id=application.id ORDER BY revision DESC LIMIT 1),false) THEN
      RAISE EXCEPTION 'Review downstream outcomes before changing the shortlist'; END IF;
    SELECT state INTO previous_state FROM public.assessment_shortlist_decision
      WHERE round_id=r.id AND application_id=application.id ORDER BY revision DESC LIMIT 1;
    IF decision->>'state'='reopened' AND EXISTS(
      SELECT 1 FROM (SELECT DISTINCT ON (audience,event_link_id) action FROM public.awards_shortlist_publication
        WHERE tenant_id=p_tenant AND round_id=r.id AND application_id=application.id
        ORDER BY audience,event_link_id,revision DESC) latest WHERE action<>'retract'
    ) THEN RAISE EXCEPTION 'Retract published shortlist entries before reopening'; END IF;
    IF (decision->>'state'='confirmed' AND previous_state IS DISTINCT FROM 'recommended')
      OR (decision->>'state' IN ('rejected','reopened') AND previous_state IS NULL)
      OR (decision->>'state'='recommended' AND coalesce(previous_state,'reopened') NOT IN ('reopened','rejected')) THEN
      RAISE EXCEPTION 'Recommend before confirmation; reopen an existing decision before replacing it'; END IF;
    IF r.moderation_required AND decision->>'state' IN ('recommended','confirmed') AND NOT EXISTS(
      SELECT 1 FROM public.assessment_moderation m WHERE m.tenant_id=p_tenant AND m.round_id=r.id AND m.application_id=application.id AND m.state='approved'
        AND (public.assessment_evidence(p_tenant,r.id,application.id)->'moderation'->>'authorityValid')::boolean
    ) THEN RAISE EXCEPTION 'Required moderation must be approved first'; END IF;
    SELECT coalesce(max(revision),0)+1 INTO next_revision FROM public.assessment_shortlist_decision
      WHERE round_id=r.id AND application_id=application.id;
    INSERT INTO public.assessment_shortlist_decision(tenant_id,award_id,round_id,application_id,revision,state,reason,
      actor_kind,actor_id,source_fingerprint,selection_mode,score_snapshot,is_override)
      VALUES(p_tenant,r.award_id,r.id,application.id,next_revision,decision->>'state',p_reason,p_actor_kind,p_actor,
        public.assessment_source_fingerprint(public.assessment_evidence(p_tenant,r.id,application.id)),p_mode,decision->'score',coalesce((decision->>'override')::boolean,false)) RETURNING id INTO saved;
    saved_ids:=array_append(saved_ids,saved);
    INSERT INTO public.awards_audit_event(tenant_id,award_id,actor_kind,actor_id,action,subject_id,reason,changes)
      VALUES(p_tenant,r.award_id,p_actor_kind,p_actor,'shortlist.decided',saved,p_reason,
        jsonb_build_object('application_id',application.id,'revision',next_revision,'state',decision->>'state','mode',p_mode));
  END LOOP;
  RETURN jsonb_build_object('decision_ids',saved_ids);
END $$;
REVOKE ALL ON FUNCTION public.assessment_round_evidence(uuid,uuid,integer) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.assessment_record_shortlist(uuid,uuid,text,uuid,text,jsonb,jsonb,text) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.assessment_round_evidence(uuid,uuid,integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.assessment_record_shortlist(uuid,uuid,text,uuid,text,jsonb,jsonb,text) TO service_role;
COMMIT;
