BEGIN;
CREATE FUNCTION public.awards_publication_event_links(p_tenant uuid,p_award uuid,p_page integer DEFAULT 1)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE w public.awards_competition; total integer; rows jsonb;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'Service authority required' USING ERRCODE='42501'; END IF;
  IF p_page IS NULL OR p_page NOT BETWEEN 1 AND 10000 THEN RAISE EXCEPTION 'Invalid page'; END IF;
  SELECT * INTO w FROM public.awards_competition WHERE tenant_id=p_tenant AND id=p_award;
  IF NOT FOUND THEN RAISE EXCEPTION 'Award unavailable' USING ERRCODE='P0002'; END IF;
  SELECT count(*) INTO total FROM public.awards_event_link WHERE tenant_id=p_tenant AND (award_id=w.id OR programme_id=w.programme_id);
  SELECT coalesce(jsonb_agg(jsonb_build_object('id',link.id,'eventId',coalesce(link.event_id,link.complex_event_id),
    'type',CASE WHEN link.event_id IS NULL THEN 'complex' ELSE 'event' END,
    'title',coalesce(nullif(to_jsonb(e)->>'title',''),nullif(to_jsonb(e)->>'name',''),
      nullif(to_jsonb(ce)->>'title',''),nullif(to_jsonb(ce)->>'name',''),'Event'),
    'audience',link.audience,'showInformation',link.show_information,'showApplicationLink',link.show_application_link) ORDER BY link.id),'[]')
    INTO rows FROM (SELECT * FROM public.awards_event_link WHERE tenant_id=p_tenant AND (award_id=w.id OR programme_id=w.programme_id)
      ORDER BY id LIMIT 50 OFFSET (p_page-1)*50) link
    LEFT JOIN public.event e ON e.id=link.event_id AND e.tenant_id=p_tenant
    LEFT JOIN public.complex_event ce ON ce.id=link.complex_event_id AND ce.tenant_id=p_tenant;
  RETURN jsonb_build_object('links',rows,'total',total,'page',p_page,'pageSize',50);
END $$;
REVOKE ALL ON FUNCTION public.awards_publication_event_links(uuid,uuid,integer) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.awards_publication_event_links(uuid,uuid,integer) TO service_role;
COMMIT;
