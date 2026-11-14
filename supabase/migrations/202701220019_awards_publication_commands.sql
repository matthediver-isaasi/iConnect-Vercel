BEGIN;
CREATE FUNCTION public.awards_publish_outcome(p_tenant uuid,p_outcome uuid,p_event_link uuid,p_audience text,
  p_action text,p_expected_revision integer,p_projection jsonb,p_reason text,p_actor_kind text,p_actor uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE outcome public.awards_outcome_revision; current_id uuid; previous public.awards_publication_revision;
  saved public.awards_publication_revision; programme uuid;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'Service authority required' USING ERRCODE='42501'; END IF;
  IF p_actor_kind NOT IN ('member','tenant_user') OR p_actor IS NULL OR p_audience NOT IN ('public','member')
    OR p_action NOT IN ('publish','correct','retract') OR length(btrim(coalesce(p_reason,'')))=0 THEN RAISE EXCEPTION 'Publication authority and reason required'; END IF;
  SELECT * INTO outcome FROM public.awards_outcome_revision WHERE tenant_id=p_tenant AND id=p_outcome;
  IF NOT FOUND THEN RAISE EXCEPTION 'Outcome unavailable' USING ERRCODE='P0002'; END IF;
  PERFORM 1 FROM public.assessment_round WHERE tenant_id=p_tenant AND id=outcome.round_id FOR UPDATE;
  PERFORM 1 FROM public.awards_application WHERE tenant_id=p_tenant AND id=outcome.application_id FOR UPDATE;
  SELECT id INTO current_id FROM public.awards_outcome_revision WHERE tenant_id=p_tenant AND application_id=outcome.application_id ORDER BY revision DESC LIMIT 1;
  IF p_action<>'retract' AND (outcome.state<>'approved' OR current_id<>outcome.id) THEN RAISE EXCEPTION 'Only the current approved outcome can be published'; END IF;
  IF p_action<>'retract' AND NOT public.awards_outcome_is_current(p_tenant,outcome.id) THEN RAISE EXCEPTION 'Approved outcome evidence changed; review before publication'; END IF;
  IF p_event_link IS NOT NULL THEN
    SELECT programme_id INTO programme FROM public.awards_competition WHERE tenant_id=p_tenant AND id=outcome.award_id;
    IF NOT EXISTS(SELECT 1 FROM public.awards_event_link WHERE tenant_id=p_tenant AND id=p_event_link
      AND (award_id=outcome.award_id OR programme_id=programme)) THEN RAISE EXCEPTION 'Event link unavailable'; END IF;
  END IF;
  SELECT p.* INTO previous FROM public.awards_publication_revision p JOIN public.awards_outcome_revision o ON o.id=p.outcome_revision_id
    WHERE p.tenant_id=p_tenant AND o.application_id=outcome.application_id AND p.audience=p_audience
      AND p.event_link_id IS NOT DISTINCT FROM p_event_link ORDER BY p.revision DESC LIMIT 1;
  IF coalesce(previous.revision,0) IS DISTINCT FROM p_expected_revision THEN RAISE EXCEPTION 'Publication changed' USING ERRCODE='40001'; END IF;
  IF p_action='correct' AND previous.id IS NULL OR p_action='retract' AND (previous.id IS NULL OR previous.action='retract') THEN
    RAISE EXCEPTION 'No existing publication to correct or retract'; END IF;
  IF p_action<>'retract' AND (jsonb_typeof(p_projection) IS DISTINCT FROM 'object'
    OR length(btrim(coalesce(p_projection->>'title','')))=0 OR length(p_projection->>'title')>300
    OR length(coalesce(p_projection->>'recipient',''))>300 OR length(coalesce(p_projection->>'summary',''))>5000
    OR EXISTS(SELECT 1 FROM jsonb_object_keys(p_projection) key WHERE key NOT IN ('title','recipient','summary'))) THEN
    RAISE EXCEPTION 'Explicit safe publication text required'; END IF;
  INSERT INTO public.awards_publication_revision(tenant_id,award_id,outcome_revision_id,event_link_id,revision,audience,action,
    safe_projection,reason,actor_kind,actor_id)
    VALUES(p_tenant,outcome.award_id,outcome.id,p_event_link,p_expected_revision+1,p_audience,p_action,
      CASE WHEN p_action='retract' THEN '{}' ELSE jsonb_build_object('title',p_projection->>'title','recipient',p_projection->>'recipient',
        'summary',p_projection->>'summary','category',outcome.category_snapshot->>'name') END,p_reason,p_actor_kind,p_actor)
    RETURNING * INTO saved;
  INSERT INTO public.awards_audit_event(tenant_id,award_id,actor_kind,actor_id,action,subject_id,reason,changes)
    VALUES(p_tenant,outcome.award_id,p_actor_kind,p_actor,'publication.'||p_action,saved.id,p_reason,
      jsonb_build_object('audience',p_audience,'revision',saved.revision,'outcome_id',outcome.id));
  RETURN jsonb_build_object('id',saved.id,'revision',saved.revision,'action',saved.action);
END $$;
CREATE FUNCTION public.awards_release_outcome(p_tenant uuid,p_outcome uuid,p_actor_kind text,p_actor uuid,p_reason text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE outcome public.awards_outcome_revision; latest uuid; release uuid;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'Service authority required' USING ERRCODE='42501'; END IF;
  IF p_actor_kind NOT IN ('member','tenant_user') OR p_actor IS NULL OR length(btrim(coalesce(p_reason,'')))=0 THEN RAISE EXCEPTION 'Release authority and reason required'; END IF;
  SELECT * INTO outcome FROM public.awards_outcome_revision WHERE tenant_id=p_tenant AND id=p_outcome;
  IF NOT FOUND THEN RAISE EXCEPTION 'Outcome unavailable'; END IF;
  PERFORM 1 FROM public.assessment_round WHERE tenant_id=p_tenant AND id=outcome.round_id FOR UPDATE;
  PERFORM 1 FROM public.awards_application WHERE tenant_id=p_tenant AND id=outcome.application_id FOR UPDATE;
  SELECT id INTO latest FROM public.awards_outcome_revision WHERE tenant_id=p_tenant AND application_id=outcome.application_id ORDER BY revision DESC LIMIT 1;
  IF outcome.state<>'approved' OR outcome.id<>latest THEN RAISE EXCEPTION 'Current approved outcome required for recipient release'; END IF;
  IF NOT public.awards_outcome_is_current(p_tenant,outcome.id) THEN RAISE EXCEPTION 'Approved outcome evidence changed; review before release'; END IF;
  SELECT id INTO release FROM public.awards_delivery_release WHERE tenant_id=p_tenant AND outcome_revision_id=outcome.id;
  IF release IS NULL THEN
    INSERT INTO public.awards_delivery_release(tenant_id,award_id,outcome_revision_id,actor_kind,actor_id,reason)
      VALUES(p_tenant,outcome.award_id,outcome.id,p_actor_kind,p_actor,p_reason) RETURNING id INTO release;
    INSERT INTO public.awards_audit_event(tenant_id,award_id,actor_kind,actor_id,action,subject_id,reason)
      VALUES(p_tenant,outcome.award_id,p_actor_kind,p_actor,'outcome.released',release,p_reason);
  END IF;
  RETURN jsonb_build_object('release_id',release);
END $$;
CREATE FUNCTION public.awards_public_outcomes(p_tenant uuid,p_award uuid,p_audience text,p_event_link uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE result jsonb;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'Service authority required' USING ERRCODE='42501'; END IF;
  IF p_audience NOT IN ('public','member') THEN RAISE EXCEPTION 'Invalid audience'; END IF;
  SELECT coalesce(jsonb_agg(safe_projection ORDER BY created_at,id),'[]') INTO result FROM (
    SELECT DISTINCT ON (o.application_id) p.id,p.safe_projection,p.action,p.created_at,o.id outcome_id,o.application_id
    FROM public.awards_publication_revision p JOIN public.awards_outcome_revision o ON o.id=p.outcome_revision_id
    WHERE p.tenant_id=p_tenant AND p.award_id=p_award AND p.audience=p_audience
      AND p.event_link_id IS NOT DISTINCT FROM p_event_link
    ORDER BY o.application_id,p.revision DESC
  ) latest WHERE latest.action<>'retract' AND EXISTS(
    SELECT 1 FROM public.awards_outcome_revision o WHERE o.id=latest.outcome_id AND o.state='approved'
      AND public.awards_outcome_is_current(p_tenant,o.id)
      AND NOT EXISTS(SELECT 1 FROM public.awards_outcome_revision newer WHERE newer.tenant_id=p_tenant
        AND newer.application_id=o.application_id AND newer.revision>o.revision)
  );
  RETURN result;
END $$;
REVOKE ALL ON FUNCTION public.awards_publish_outcome(uuid,uuid,uuid,text,text,integer,jsonb,text,text,uuid) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.awards_release_outcome(uuid,uuid,text,uuid,text) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.awards_public_outcomes(uuid,uuid,text,uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.awards_publish_outcome(uuid,uuid,uuid,text,text,integer,jsonb,text,text,uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.awards_release_outcome(uuid,uuid,text,uuid,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.awards_public_outcomes(uuid,uuid,text,uuid) TO service_role;
COMMIT;
