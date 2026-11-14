BEGIN;
CREATE FUNCTION public.awards_event_progress(p_tenant uuid,p_link uuid,p_page integer DEFAULT 1)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE association public.awards_event_link; rows jsonb; total integer;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'Service authority required' USING ERRCODE='42501'; END IF;
  IF p_page IS NULL OR p_page NOT BETWEEN 1 AND 10000 THEN RAISE EXCEPTION 'Invalid progress page'; END IF;
  SELECT * INTO association FROM public.awards_event_link WHERE tenant_id=p_tenant AND id=p_link;
  IF NOT FOUND THEN RAISE EXCEPTION 'Event association unavailable' USING ERRCODE='P0002'; END IF;
  SELECT count(*) INTO total FROM public.awards_competition w WHERE w.tenant_id=p_tenant
    AND (w.id=association.award_id OR w.programme_id=association.programme_id);
  SELECT coalesce(jsonb_agg(jsonb_build_object('id',w.id,'name',w.name,'state',w.state,
    'applications',(SELECT jsonb_build_object('total',count(*),'eligible',count(*) FILTER(WHERE a.eligibility='eligible'),
      'pending',count(*) FILTER(WHERE a.eligibility='pending'),'withdrawn',count(*) FILTER(WHERE a.eligibility='withdrawn'),
      'ineligible',count(*) FILTER(WHERE a.eligibility IN ('ineligible','disqualified')))
      FROM public.awards_application a WHERE a.tenant_id=p_tenant AND a.award_id=w.id),
    'rounds',(SELECT count(*) FROM public.assessment_round r WHERE r.tenant_id=p_tenant AND r.award_id=w.id),
    'assessments',(SELECT jsonb_build_object('assigned',count(*),'submitted',count(*) FILTER(WHERE latest.state='submitted'),
      'scored',count(*) FILTER(WHERE latest.state='submitted' AND latest.exact_score IS NOT NULL))
      FROM public.assessment_assignment s JOIN public.awards_application a ON a.id=s.application_id
      LEFT JOIN LATERAL(SELECT ar.state,ar.exact_score FROM public.assessment_revision ar
        WHERE ar.assignment_id=s.id ORDER BY ar.revision DESC LIMIT 1) latest ON true
      WHERE s.tenant_id=p_tenant AND s.award_id=w.id AND s.state='assigned' AND s.included
        AND s.conflict IN ('none','cleared') AND a.eligibility='eligible'),
    'approvedOutcomes',(SELECT count(*) FROM public.awards_outcome_revision o
      WHERE o.tenant_id=p_tenant AND o.award_id=w.id AND o.state='approved' AND public.awards_outcome_is_current(p_tenant,o.id))
    ) ORDER BY w.name,w.id),'[]') INTO rows
    FROM (SELECT * FROM public.awards_competition WHERE tenant_id=p_tenant
      AND (id=association.award_id OR programme_id=association.programme_id)
      ORDER BY name,id LIMIT 25 OFFSET (p_page-1)*25) w;
  RETURN jsonb_build_object('awards',rows,'total',total,'page',p_page,'pageSize',25);
END $$;
REVOKE ALL ON FUNCTION public.awards_event_progress(uuid,uuid,integer) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.awards_event_progress(uuid,uuid,integer) TO service_role;
COMMIT;
