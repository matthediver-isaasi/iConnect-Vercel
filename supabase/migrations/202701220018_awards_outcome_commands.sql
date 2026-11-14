BEGIN;
ALTER TABLE public.awards_outcome_revision ADD COLUMN round_id uuid;
ALTER TABLE public.awards_outcome_revision ADD COLUMN source_fingerprint text;
ALTER TABLE public.awards_outcome_revision ADD COLUMN score_snapshot jsonb;
ALTER TABLE public.awards_outcome_revision ADD COLUMN category_snapshot jsonb;
ALTER TABLE public.awards_outcome_revision ADD COLUMN is_override boolean NOT NULL DEFAULT false;
ALTER TABLE public.awards_outcome_revision ADD FOREIGN KEY (tenant_id,award_id,round_id)
  REFERENCES public.assessment_round(tenant_id,award_id,id);
ALTER TABLE public.awards_outcome_revision ADD COLUMN actor_identity_keys text[] NOT NULL DEFAULT '{}';
CREATE FUNCTION public.awards_category_command(p_tenant uuid,p_award uuid,p_actor_kind text,p_actor uuid,p_id uuid,p_payload jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE category public.awards_outcome_category;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'Service authority required' USING ERRCODE='42501'; END IF;
  IF p_actor_kind NOT IN ('member','tenant_user') OR p_actor IS NULL THEN RAISE EXCEPTION 'Actor required'; END IF;
  PERFORM 1 FROM public.awards_competition WHERE tenant_id=p_tenant AND id=p_award FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Award unavailable' USING ERRCODE='P0002'; END IF;
  IF p_id IS NULL THEN
    INSERT INTO public.awards_outcome_category(tenant_id,award_id,name,certificate_enabled)
      VALUES(p_tenant,p_award,p_payload->>'name',coalesce((p_payload->>'certificate_enabled')::boolean,false)) RETURNING * INTO category;
  ELSE
    IF EXISTS(SELECT 1 FROM public.awards_outcome_revision WHERE tenant_id=p_tenant AND category_id=p_id) THEN
      RAISE EXCEPTION 'Used categories are immutable; create another category'; END IF;
    UPDATE public.awards_outcome_category SET name=p_payload->>'name',
      certificate_enabled=coalesce((p_payload->>'certificate_enabled')::boolean,false)
      WHERE tenant_id=p_tenant AND award_id=p_award AND id=p_id RETURNING * INTO category;
    IF NOT FOUND THEN RAISE EXCEPTION 'Category unavailable' USING ERRCODE='P0002'; END IF;
  END IF;
  INSERT INTO public.awards_audit_event(tenant_id,award_id,actor_kind,actor_id,action,subject_id,changes)
    VALUES(p_tenant,p_award,p_actor_kind,p_actor,'category.configured',category.id,jsonb_build_object('name',category.name,'certificate_enabled',category.certificate_enabled));
  RETURN to_jsonb(category);
END $$;
CREATE FUNCTION public.awards_record_outcome(p_tenant uuid,p_round uuid,p_application uuid,p_category uuid,
  p_expected_revision integer,p_state text,p_method text,p_reason text,p_override boolean,
  p_fingerprint text,p_score jsonb,p_actor_kind text,p_actor uuid,p_all_fingerprints jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE r public.assessment_round; a public.awards_application; c public.awards_outcome_category;
  previous public.awards_outcome_revision; saved public.awards_outcome_revision; current_fingerprint text; candidate uuid; award uuid;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'Service authority required' USING ERRCODE='42501'; END IF;
  IF p_actor_kind NOT IN ('member','tenant_user') OR p_actor IS NULL
    OR p_state NOT IN ('provisional','recommended','approved','reopened') OR p_method NOT IN ('score','panel','manual')
    OR length(btrim(coalesce(p_reason,'')))=0 OR p_override IS NULL THEN RAISE EXCEPTION 'Outcome authority and reason required'; END IF;
  SELECT award_id INTO award FROM public.assessment_round WHERE tenant_id=p_tenant AND id=p_round;
  PERFORM 1 FROM public.awards_competition WHERE tenant_id=p_tenant AND id=award FOR UPDATE;
  SELECT * INTO r FROM public.assessment_round WHERE tenant_id=p_tenant AND id=p_round FOR UPDATE;
  IF NOT FOUND OR r.state NOT IN ('judging','moderation','closed') THEN RAISE EXCEPTION 'Round not ready for decisions'; END IF;
  IF jsonb_typeof(p_all_fingerprints) IS DISTINCT FROM 'object' OR
    (SELECT count(*) FROM public.awards_application WHERE tenant_id=p_tenant AND award_id=r.award_id AND public.assessment_round_candidate(p_tenant,r.id,id))
    <> (SELECT count(*) FROM jsonb_object_keys(p_all_fingerprints)) THEN RAISE EXCEPTION 'Ranking set changed' USING ERRCODE='40001'; END IF;
  FOR candidate IN SELECT id FROM public.awards_application WHERE tenant_id=p_tenant AND award_id=r.award_id
    AND public.assessment_round_candidate(p_tenant,r.id,id) ORDER BY id LOOP
    IF public.assessment_fingerprint(public.assessment_evidence(p_tenant,r.id,candidate)) IS DISTINCT FROM p_all_fingerprints->>candidate::text THEN
      RAISE EXCEPTION 'Ranking evidence changed' USING ERRCODE='40001'; END IF;
  END LOOP;
  SELECT * INTO a FROM public.awards_application WHERE tenant_id=p_tenant AND award_id=r.award_id AND id=p_application FOR UPDATE;
  IF NOT FOUND OR NOT public.assessment_round_candidate(p_tenant,r.id,a.id) OR a.eligibility<>'eligible' THEN RAISE EXCEPTION 'Eligible round application required'; END IF;
  SELECT * INTO c FROM public.awards_outcome_category WHERE tenant_id=p_tenant AND award_id=r.award_id AND id=p_category FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Outcome category unavailable'; END IF;
  SELECT * INTO previous FROM public.awards_outcome_revision WHERE tenant_id=p_tenant AND application_id=a.id ORDER BY revision DESC LIMIT 1;
  IF coalesce(previous.revision,0) IS DISTINCT FROM p_expected_revision THEN RAISE EXCEPTION 'Outcome changed' USING ERRCODE='40001'; END IF;
  IF NOT ((p_state='provisional' AND (previous.id IS NULL OR previous.state='reopened'))
    OR (p_state='recommended' AND coalesce(previous.state,'')='provisional')
    OR (p_state='approved' AND coalesce(previous.state,'')='recommended')
    OR (p_state='reopened' AND coalesce(previous.state,'') IN ('provisional','recommended','approved'))) THEN RAISE EXCEPTION 'Invalid outcome transition'; END IF;
  IF p_state='reopened' AND EXISTS(
    SELECT 1 FROM (SELECT DISTINCT ON (p.audience,p.event_link_id) p.action
      FROM public.awards_publication_revision p JOIN public.awards_outcome_revision o ON o.id=p.outcome_revision_id
      WHERE p.tenant_id=p_tenant AND o.application_id=a.id ORDER BY p.audience,p.event_link_id,p.revision DESC) latest
    WHERE latest.action<>'retract'
  ) THEN RAISE EXCEPTION 'Retract published results with a correction reason before reopening'; END IF;
  current_fingerprint:=public.assessment_fingerprint(public.assessment_evidence(p_tenant,r.id,a.id));
  IF current_fingerprint IS DISTINCT FROM p_fingerprint THEN RAISE EXCEPTION 'Assessment evidence changed' USING ERRCODE='40001'; END IF;
  IF p_state IN ('recommended','approved') THEN
    IF previous.category_id<>c.id OR previous.selection_method<>p_method OR previous.source_fingerprint<>public.assessment_source_fingerprint(public.assessment_evidence(p_tenant,r.id,a.id))
      OR previous.score_snapshot IS DISTINCT FROM p_score THEN RAISE EXCEPTION 'Reopen before changing the recommendation'; END IF;
    IF p_method='score' AND previous.ranking_sources IS DISTINCT FROM public.assessment_ranking_sources(p_tenant,r.id) THEN
      RAISE EXCEPTION 'Ranking evidence changed; reopen the recommendation' USING ERRCODE='40001'; END IF;
    IF r.moderation_required AND NOT EXISTS(SELECT 1 FROM public.assessment_moderation WHERE tenant_id=p_tenant AND round_id=r.id
      AND application_id=a.id AND state='approved'
      AND (public.assessment_evidence(p_tenant,r.id,a.id)->'moderation'->>'authorityValid')::boolean) THEN RAISE EXCEPTION 'Required moderation is not approved'; END IF;
  END IF;
  IF p_state IN ('provisional','recommended','approved') AND public.assessment_actor_conflicted(
    p_tenant,r.id,a.id,public.assessment_actor_keys(p_tenant,p_actor_kind,p_actor)) THEN
    RAISE EXCEPTION 'Resolve your declared conflict before deciding this outcome'; END IF;
  IF p_state='approved' AND NOT r.self_approval AND
    (cardinality(previous.actor_identity_keys)=0 OR previous.actor_identity_keys && public.assessment_actor_keys(p_tenant,p_actor_kind,p_actor)) THEN
    RAISE EXCEPTION 'A separate outcome approver is required'; END IF;
  INSERT INTO public.awards_outcome_revision(tenant_id,award_id,round_id,application_id,category_id,revision,state,selection_method,reason,
    actor_kind,actor_id,source_fingerprint,score_snapshot,category_snapshot,is_override,ranking_sources,actor_identity_keys)
    VALUES(p_tenant,r.award_id,r.id,a.id,c.id,p_expected_revision+1,p_state,p_method,p_reason,p_actor_kind,p_actor,
      public.assessment_source_fingerprint(public.assessment_evidence(p_tenant,r.id,a.id)),p_score,to_jsonb(c),p_override,
      CASE WHEN p_method='score' THEN public.assessment_ranking_sources(p_tenant,r.id) ELSE '{}'::jsonb END,
      public.assessment_actor_keys(p_tenant,p_actor_kind,p_actor)) RETURNING * INTO saved;
  INSERT INTO public.awards_audit_event(tenant_id,award_id,actor_kind,actor_id,action,subject_id,reason,changes)
    VALUES(p_tenant,r.award_id,p_actor_kind,p_actor,'outcome.'||p_state,saved.id,p_reason,
      jsonb_build_object('application_id',a.id,'revision',saved.revision,'category_id',c.id,'override',p_override));
  RETURN to_jsonb(saved)-'actor_identity_keys';
END $$;
REVOKE ALL ON FUNCTION public.awards_category_command(uuid,uuid,text,uuid,uuid,jsonb) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.awards_record_outcome(uuid,uuid,uuid,uuid,integer,text,text,text,boolean,text,jsonb,text,uuid,jsonb) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.awards_category_command(uuid,uuid,text,uuid,uuid,jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.awards_record_outcome(uuid,uuid,uuid,uuid,integer,text,text,text,boolean,text,jsonb,text,uuid,jsonb) TO service_role;
COMMIT;
