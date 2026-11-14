BEGIN;
CREATE FUNCTION public.awards_applicant_status(p_tenant uuid,p_member uuid,p_application uuid DEFAULT NULL,p_page integer DEFAULT 1,p_access_hash text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE rows jsonb; total integer;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'Service authority required' USING ERRCODE='42501'; END IF;
  IF (p_member IS NULL AND (p_application IS NULL OR p_access_hash IS NULL)) OR p_page IS NULL OR p_page NOT BETWEEN 1 AND 10000 THEN RAISE EXCEPTION 'Applicant and page required'; END IF;
  SELECT count(*) INTO total FROM public.awards_application a
    WHERE a.tenant_id=p_tenant AND (a.member_id=p_member OR (p_member IS NULL AND public.awards_external_applicant(p_tenant,a.id,p_access_hash) IS NOT NULL))
      AND (p_application IS NULL OR a.id=p_application);
  SELECT coalesce(jsonb_agg(row ORDER BY created_at DESC,id),'[]') INTO rows FROM (
    SELECT a.id,a.created_at,jsonb_build_object('id',a.id,'awardId',a.award_id,'reference',a.reference,'version',a.version,
      'awardName',w.name,'submittedAt',a.created_at,'status',
      CASE a.eligibility WHEN 'eligible' THEN 'Eligible' WHEN 'withdrawn' THEN 'Withdrawn'
        WHEN 'ineligible' THEN 'Not eligible' WHEN 'disqualified' THEN 'Disqualified' ELSE 'Received' END,
      'canAmend',w.amendments_enabled AND w.state='open' AND clock_timestamp()>=w.opens_at AND clock_timestamp()<w.closes_at
        AND a.eligibility NOT IN ('withdrawn','disqualified'),
      'canWithdraw',a.eligibility<>'withdrawn' AND NOT EXISTS(
        SELECT 1 FROM public.awards_outcome_revision o WHERE o.tenant_id=p_tenant AND o.application_id=a.id AND o.state<>'reopened'
        AND NOT EXISTS(SELECT 1 FROM public.awards_outcome_revision newer WHERE newer.application_id=a.id AND newer.revision>o.revision)),
      'certificates',(SELECT coalesce(jsonb_agg(jsonb_build_object('id',issued.id,'issuedAt',issued.created_at,
        'category',o.category_snapshot->>'name') ORDER BY issued.created_at DESC),'[]')
        FROM public.awards_certificate_issue issued JOIN public.awards_outcome_revision o ON o.id=issued.outcome_revision_id
        WHERE issued.tenant_id=p_tenant AND o.application_id=a.id AND EXISTS(
          SELECT 1 FROM public.awards_delivery_release release WHERE release.tenant_id=p_tenant AND release.outcome_revision_id=o.id)),
      'outcome',(SELECT o.category_snapshot->>'name' FROM public.awards_outcome_revision o
        JOIN public.awards_delivery_release release ON release.tenant_id=o.tenant_id AND release.outcome_revision_id=o.id
        WHERE o.tenant_id=p_tenant AND o.application_id=a.id AND o.state='approved'
          AND public.awards_outcome_is_current(p_tenant,o.id)
          AND NOT EXISTS(SELECT 1 FROM public.awards_outcome_revision newer WHERE newer.application_id=a.id AND newer.revision>o.revision)
        ORDER BY o.revision DESC LIMIT 1)
    ) row FROM public.awards_application a JOIN public.awards_competition w ON w.id=a.award_id AND w.tenant_id=p_tenant
      WHERE a.tenant_id=p_tenant AND (a.member_id=p_member OR (p_member IS NULL AND public.awards_external_applicant(p_tenant,a.id,p_access_hash) IS NOT NULL))
        AND (p_application IS NULL OR a.id=p_application)
      ORDER BY a.created_at DESC,a.id LIMIT 50 OFFSET (p_page-1)*50
  ) selected;
  RETURN jsonb_build_object('applications',rows,'total',total,'page',p_page,'pageSize',50);
END $$;
REVOKE ALL ON FUNCTION public.awards_applicant_status(uuid,uuid,uuid,integer,text) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.awards_applicant_status(uuid,uuid,uuid,integer,text) TO service_role;
COMMIT;
