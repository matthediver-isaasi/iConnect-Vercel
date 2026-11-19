BEGIN;
-- UUID[] and JSONB source schemas have both existed. Normalize at the boundary.
CREATE OR REPLACE FUNCTION public.zoom_speaker_desired(p_tenant uuid,p_webinar uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
  WITH w AS (SELECT * FROM public.zoom_webinar WHERE id=p_webinar AND tenant_id=p_tenant),
  ids AS (
    SELECT jsonb_array_elements_text(COALESCE(to_jsonb(e.speaker_ids),'[]')) id FROM public.event e,w
      WHERE e.tenant_id=p_tenant AND e.zoom_webinar_id=w.id AND NOT COALESCE(e.is_training,false)
    UNION
    SELECT jsonb_array_elements_text(COALESCE(to_jsonb(s.speaker_ids),'[]')) FROM public.complex_event_session s,w
      WHERE s.tenant_id=p_tenant AND s.zoom_webinar_id::text IN(w.id::text,w.zoom_webinar_id::text)
    UNION
    SELECT jsonb_array_elements_text(COALESCE(to_jsonb(a.speaker_ids),'[]'))
      FROM public.event_agenda_item a JOIN public.event e ON e.id=a.event_id AND e.tenant_id=a.tenant_id,w
      WHERE a.tenant_id=p_tenant AND (a.zoom_webinar_id=w.id OR (a.zoom_webinar_id IS NULL AND e.zoom_webinar_id=w.id))
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object('id',ids.id,'name',s.full_name,'email',s.email,'found',s.id IS NOT NULL)
    ORDER BY ids.id),'[]') FROM ids LEFT JOIN public.speaker s ON s.id::text=ids.id AND s.tenant_id=p_tenant
$$;
REVOKE ALL ON FUNCTION public.zoom_speaker_desired(uuid,uuid) FROM PUBLIC,anon,authenticated;
NOTIFY pgrst,'reload schema';
COMMIT;
