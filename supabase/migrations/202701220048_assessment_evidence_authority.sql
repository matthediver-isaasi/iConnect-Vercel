BEGIN;
-- A scoring approval depends on evidence, inclusion and scoring policy, not
-- cosmetic round metadata, deadlines or the shortlist record it creates.
CREATE FUNCTION public.assessment_fingerprint(p_evidence jsonb)
RETURNS text LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,public AS $$
  SELECT md5(((p_evidence-'round')||jsonb_build_object('policy',
    jsonb_build_object('required_judges',p_evidence->'round'->'required_judges',
      'require_all',p_evidence->'round'->'require_all','moderation_required',p_evidence->'round'->'moderation_required',
      'self_approval',p_evidence->'round'->'self_approval')))::text);
$$;
CREATE FUNCTION public.assessment_source_fingerprint(p_evidence jsonb)
RETURNS text LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,public AS $$
  SELECT public.assessment_fingerprint(p_evidence-'shortlist');
$$;
CREATE FUNCTION public.awards_outcome_is_current(p_tenant uuid,p_outcome uuid)
RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE o public.awards_outcome_revision;
BEGIN
  SELECT * INTO o FROM public.awards_outcome_revision WHERE tenant_id=p_tenant AND id=p_outcome;
  IF NOT FOUND OR o.state<>'approved' OR EXISTS(SELECT 1 FROM public.awards_outcome_revision WHERE application_id=o.application_id AND revision>o.revision)
    OR NOT EXISTS(SELECT 1 FROM public.awards_application WHERE id=o.application_id AND tenant_id=p_tenant AND eligibility='eligible') THEN RETURN false; END IF;
  IF o.selection_method='score' AND o.ranking_sources IS DISTINCT FROM public.assessment_ranking_sources(p_tenant,o.round_id) THEN RETURN false; END IF;
  IF cardinality(o.actor_identity_keys)=0 OR public.assessment_actor_conflicted(p_tenant,o.round_id,o.application_id,o.actor_identity_keys)
    OR EXISTS(SELECT 1 FROM public.awards_outcome_revision previous WHERE previous.application_id=o.application_id
      AND previous.revision=o.revision-1 AND (cardinality(previous.actor_identity_keys)=0 OR
        public.assessment_actor_conflicted(p_tenant,o.round_id,o.application_id,previous.actor_identity_keys))) THEN RETURN false; END IF;
  RETURN o.source_fingerprint=public.assessment_source_fingerprint(public.assessment_evidence(p_tenant,o.round_id,o.application_id));
END $$;
CREATE FUNCTION public.awards_shortlist_is_current(p_tenant uuid,p_shortlist uuid)
RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE s public.assessment_shortlist_decision;
BEGIN
  SELECT * INTO s FROM public.assessment_shortlist_decision WHERE tenant_id=p_tenant AND id=p_shortlist;
  IF NOT FOUND OR s.state<>'confirmed' OR EXISTS(SELECT 1 FROM public.assessment_shortlist_decision WHERE round_id=s.round_id AND application_id=s.application_id AND revision>s.revision)
    OR NOT EXISTS(SELECT 1 FROM public.awards_application WHERE id=s.application_id AND tenant_id=p_tenant AND eligibility='eligible') THEN RETURN false; END IF;
  RETURN s.source_fingerprint=public.assessment_source_fingerprint(public.assessment_evidence(p_tenant,s.round_id,s.application_id));
END $$;
REVOKE ALL ON FUNCTION public.assessment_fingerprint(jsonb) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.assessment_source_fingerprint(jsonb) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.awards_outcome_is_current(uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.awards_shortlist_is_current(uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;
COMMIT;
