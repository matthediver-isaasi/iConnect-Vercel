-- Viewer criteria never change saved reports or grant additional field access.
BEGIN;
ALTER TABLE public.custom_object_report_sort_job
  ADD COLUMN IF NOT EXISTS viewer_query jsonb;

CREATE OR REPLACE FUNCTION public.custom_object_report_viewer_matches(p_values jsonb,p_query jsonb)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE SET search_path=pg_catalog,public AS $$
DECLARE f jsonb; cell text; needle text; search_text text; matches boolean:=true;
BEGIN
  IF jsonb_typeof(p_values) IS DISTINCT FROM 'array'
    OR jsonb_typeof(p_query) IS DISTINCT FROM 'object'
    OR (p_query - ARRAY['search','filters']) <> '{}'::jsonb
    OR jsonb_typeof(p_query->'search') IS DISTINCT FROM 'string'
    OR length(p_query->>'search')>200
    OR jsonb_typeof(p_query->'filters') IS DISTINCT FROM 'array'
    OR jsonb_array_length(p_query->'filters')>20 THEN
    RAISE EXCEPTION 'Invalid report search or filters' USING ERRCODE='22023';
  END IF;
  search_text:=lower(btrim(p_query->>'search'));
  IF search_text<>'' AND NOT EXISTS(
    SELECT 1 FROM jsonb_array_elements_text(p_values) v
    WHERE strpos(lower(btrim(coalesce(v,''))),search_text)>0
  ) THEN matches:=false; END IF;
  FOR f IN SELECT value FROM jsonb_array_elements(p_query->'filters') LOOP
    IF jsonb_typeof(f) IS DISTINCT FROM 'object' OR (f - ARRAY['column','operator','value'])<>'{}'::jsonb
      OR jsonb_typeof(f->'column') IS DISTINCT FROM 'number' OR (f->>'column')!~'^[0-9]{1,6}$'
      OR (f->>'column')::integer>=jsonb_array_length(p_values)
      OR jsonb_typeof(f->'operator') IS DISTINCT FROM 'string'
      OR f->>'operator' NOT IN ('contains','starts_with','equals','not_equals','empty','not_empty')
      OR jsonb_typeof(f->'value') IS DISTINCT FROM 'string' OR length(f->>'value')>200 THEN
      RAISE EXCEPTION 'Invalid report field filter' USING ERRCODE='22023';
    END IF;
    cell:=lower(btrim(coalesce(p_values->>(f->>'column')::integer,'')));
    needle:=lower(btrim(f->>'value'));
    IF f->>'operator' NOT IN ('empty','not_empty') AND needle='' THEN
      RAISE EXCEPTION 'Enter a filter value' USING ERRCODE='22023';
    END IF;
    IF NOT (CASE f->>'operator'
      WHEN 'contains' THEN strpos(cell,needle)>0
      WHEN 'starts_with' THEN starts_with(cell,needle)
      WHEN 'equals' THEN cell=needle
      WHEN 'not_equals' THEN cell<>needle
      WHEN 'empty' THEN cell=''
      WHEN 'not_empty' THEN cell<>''
      ELSE false END) THEN matches:=false; END IF;
  END LOOP;
  RETURN matches;
END;
$$;

CREATE OR REPLACE FUNCTION public.custom_object_report_viewer_page(
  p_tenant_id uuid,p_job_id uuid,p_query jsonb,p_offset bigint,p_limit integer
) RETURNS jsonb LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE j public.custom_object_report_sort_job%ROWTYPE; result jsonb;
BEGIN
  IF p_offset IS NULL OR p_offset<0 OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 500 THEN
    RAISE EXCEPTION 'Invalid report page' USING ERRCODE='22023';
  END IF;
  SELECT * INTO j FROM public.custom_object_report_sort_job
    WHERE tenant_id=p_tenant_id AND id=p_job_id AND mode='preview'
      AND requested_by_report_grant_id IS NOT NULL AND status='ready' AND expires_at>now();
  IF NOT FOUND THEN RAISE EXCEPTION 'Report snapshot unavailable' USING ERRCODE='P0001'; END IF;
  -- Validate even an empty snapshot. Only published column positions exist.
  PERFORM public.custom_object_report_viewer_matches(
    (SELECT coalesce(jsonb_agg(''::text),'[]'::jsonb) FROM jsonb_array_elements(j.headers)),p_query);
  WITH matched AS MATERIALIZED (
    SELECT r.row_identity,r.position FROM public.custom_object_report_sort_row r
    WHERE r.tenant_id=p_tenant_id AND r.job_id=p_job_id
      AND public.custom_object_report_viewer_matches(r.row_values,p_query)
  ), selected AS (
    SELECT * FROM matched ORDER BY position OFFSET p_offset LIMIT p_limit
  )
  SELECT jsonb_build_object('total',(SELECT count(*) FROM matched),'data',
    coalesce(jsonb_agg(jsonb_build_object('id',r.row_identity,'values',r.row_values)
      ORDER BY selected.position) FILTER(WHERE r.row_identity IS NOT NULL),'[]'::jsonb))
    INTO result FROM selected JOIN public.custom_object_report_sort_row r
      ON r.tenant_id=p_tenant_id AND r.job_id=p_job_id AND r.row_identity=selected.row_identity;
  RETURN result;
END;
$$;
REVOKE ALL ON FUNCTION public.custom_object_report_viewer_matches(jsonb,jsonb),
  public.custom_object_report_viewer_page(uuid,uuid,jsonb,bigint,integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.custom_object_report_viewer_matches(jsonb,jsonb),
  public.custom_object_report_viewer_page(uuid,uuid,jsonb,bigint,integer) TO service_role;
NOTIFY pgrst,'reload schema';
COMMIT;
