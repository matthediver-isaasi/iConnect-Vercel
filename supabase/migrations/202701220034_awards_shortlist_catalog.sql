BEGIN;
CREATE FUNCTION public.awards_shortlist_catalog(p_tenant uuid,p_award uuid,p_page integer DEFAULT 1)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE entries jsonb; publications jsonb; total integer; publication_total integer;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'Service authority required' USING ERRCODE='42501'; END IF;
  IF p_page IS NULL OR p_page NOT BETWEEN 1 AND 10000 THEN RAISE EXCEPTION 'Invalid page'; END IF;
  SELECT count(*) INTO total FROM public.assessment_shortlist_decision s JOIN public.awards_application a ON a.id=s.application_id
    WHERE s.tenant_id=p_tenant AND s.award_id=p_award AND s.state='confirmed' AND a.eligibility='eligible'
      AND NOT EXISTS(SELECT 1 FROM public.assessment_shortlist_decision newer WHERE newer.round_id=s.round_id AND newer.application_id=s.application_id AND newer.revision>s.revision);
  SELECT coalesce(jsonb_agg(to_jsonb(selected) ORDER BY selected.id),'[]') INTO entries FROM (
    SELECT s.id,s.round_id,s.application_id,s.revision,a.reference,r.name round_name
      FROM public.assessment_shortlist_decision s JOIN public.awards_application a ON a.id=s.application_id JOIN public.assessment_round r ON r.id=s.round_id
      WHERE s.tenant_id=p_tenant AND s.award_id=p_award AND s.state='confirmed' AND a.eligibility='eligible'
        AND NOT EXISTS(SELECT 1 FROM public.assessment_shortlist_decision newer WHERE newer.round_id=s.round_id AND newer.application_id=s.application_id AND newer.revision>s.revision)
      ORDER BY s.id LIMIT 50 OFFSET (p_page-1)*50
  ) selected;
  SELECT count(*) INTO publication_total FROM public.awards_shortlist_publication WHERE tenant_id=p_tenant AND award_id=p_award;
  SELECT coalesce(jsonb_agg(to_jsonb(selected) ORDER BY created_at DESC,id),'[]') INTO publications FROM (
    SELECT id,round_id,application_id,shortlist_id,event_link_id,audience,revision,action,safe_projection,reason,created_at
      FROM public.awards_shortlist_publication WHERE tenant_id=p_tenant AND award_id=p_award
      ORDER BY created_at DESC,id LIMIT 50 OFFSET (p_page-1)*50
  ) selected;
  RETURN jsonb_build_object('shortlists',entries,'total',total,'publications',publications,'publicationTotal',publication_total,'page',p_page,'pageSize',50);
END $$;
REVOKE ALL ON FUNCTION public.awards_shortlist_catalog(uuid,uuid,integer) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.awards_shortlist_catalog(uuid,uuid,integer) TO service_role;
COMMIT;
