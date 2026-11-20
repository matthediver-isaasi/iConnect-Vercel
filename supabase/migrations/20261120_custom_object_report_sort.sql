-- Service-owned, short-lived materialisation. No saved report is rewritten.
BEGIN;
CREATE TABLE IF NOT EXISTS public.custom_object_report_sort_job (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  custom_object_id uuid NOT NULL,
  mode text NOT NULL CHECK (mode IN ('preview','export')),
  definition jsonb NOT NULL,
  sort_rules jsonb NOT NULL CHECK (jsonb_typeof(sort_rules) = 'array'),
  headers jsonb NOT NULL DEFAULT '[]',
  filename text NOT NULL,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','processing','ready','failed')),
  requested_by_member_id text,
  requested_by_tenant_user_id text,
  processed bigint NOT NULL DEFAULT 0,
  total bigint NOT NULL DEFAULT 0,
  next_page integer NOT NULL DEFAULT 1,
  chunk_size integer NOT NULL DEFAULT 200 CHECK (chunk_size BETWEEN 1 AND 500),
  cursor_value text,
  claim_token uuid,
  error_message text,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  CHECK (num_nonnulls(requested_by_member_id, requested_by_tenant_user_id) = 1)
);
CREATE TABLE IF NOT EXISTS public.custom_object_report_sort_row (
  tenant_id uuid NOT NULL,
  job_id uuid NOT NULL,
  row_identity text NOT NULL,
  row_values jsonb NOT NULL CHECK (jsonb_typeof(row_values) = 'array'),
  sort_values jsonb NOT NULL CHECK (jsonb_typeof(sort_values) = 'array'),
  position bigint,
  PRIMARY KEY (tenant_id, job_id, row_identity),
  FOREIGN KEY (tenant_id, job_id) REFERENCES public.custom_object_report_sort_job(tenant_id,id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS custom_object_report_sort_position
  ON public.custom_object_report_sort_row(tenant_id,job_id,position);
CREATE INDEX IF NOT EXISTS custom_object_report_sort_expiry ON public.custom_object_report_sort_job(expires_at);
ALTER TABLE public.custom_object_report_sort_job ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.custom_object_report_sort_row ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.custom_object_report_sort_job, public.custom_object_report_sort_row FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.custom_object_report_sort_job, public.custom_object_report_sort_row TO service_role;

CREATE OR REPLACE FUNCTION public.custom_object_report_sort_prune(p_tenant_id uuid)
RETURNS void LANGUAGE plpgsql SET search_path=public AS $$
BEGIN
  DELETE FROM public.custom_object_report_sort_row r USING (
    SELECT r.ctid FROM public.custom_object_report_sort_row r
      JOIN public.custom_object_report_sort_job j ON j.tenant_id=r.tenant_id AND j.id=r.job_id
      WHERE j.tenant_id=p_tenant_id AND j.expires_at<=now() LIMIT 1000
      FOR UPDATE OF r SKIP LOCKED
  ) expired WHERE r.ctid=expired.ctid;
  DELETE FROM public.custom_object_report_sort_job j USING (
    SELECT j.id FROM public.custom_object_report_sort_job j
    WHERE j.tenant_id=p_tenant_id AND j.expires_at<=now()
      AND NOT EXISTS (SELECT 1 FROM public.custom_object_report_sort_row r WHERE r.tenant_id=j.tenant_id AND r.job_id=j.id)
    LIMIT 10 FOR UPDATE OF j SKIP LOCKED
  ) expired WHERE j.tenant_id=p_tenant_id AND j.id=expired.id;
END;
$$;
REVOKE ALL ON FUNCTION public.custom_object_report_sort_prune(uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.custom_object_report_sort_prune(uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.custom_object_report_sort_commit(
  p_tenant_id uuid, p_object_id uuid, p_job_id uuid, p_claim_token uuid,
  p_page integer, p_rows jsonb, p_headers jsonb, p_next_cursor text, p_has_more boolean
) RETURNS jsonb LANGUAGE plpgsql SET search_path = public AS $$
DECLARE
  j public.custom_object_report_sort_job%ROWTYPE;
  rule jsonb;
  ordering text := '';
  idx integer;
  direction text;
  item jsonb;
  inserted_count integer;
BEGIN
  SELECT * INTO j FROM public.custom_object_report_sort_job
    WHERE tenant_id=p_tenant_id AND custom_object_id=p_object_id AND id=p_job_id FOR UPDATE;
  IF NOT FOUND OR j.claim_token IS DISTINCT FROM p_claim_token OR p_claim_token IS NULL
    OR j.next_page IS DISTINCT FROM p_page OR j.status <> 'processing'
    OR j.expires_at <= now() THEN
    RAISE EXCEPTION 'Sorted report claim expired' USING ERRCODE='P0001';
  END IF;
  IF jsonb_typeof(p_rows) IS DISTINCT FROM 'array' OR jsonb_array_length(p_rows)>j.chunk_size
    OR jsonb_typeof(p_headers) IS DISTINCT FROM 'array' OR p_has_more IS NULL THEN
    RAISE EXCEPTION 'Malformed sorted report page' USING ERRCODE='22023';
  END IF;
  IF p_has_more AND (p_next_cursor IS NULL OR p_next_cursor IS NOT DISTINCT FROM j.cursor_value) THEN
    RAISE EXCEPTION 'Sorted report source did not advance' USING ERRCODE='22023';
  END IF;
  IF j.next_page>1 AND j.headers IS DISTINCT FROM p_headers THEN
    RAISE EXCEPTION 'Sorted report column metadata changed during preparation' USING ERRCODE='22023';
  END IF;
  FOR item IN SELECT value FROM jsonb_array_elements(p_rows) LOOP
    IF NULLIF(item->>'id','') IS NULL OR jsonb_typeof(item->'values') IS DISTINCT FROM 'array'
      OR jsonb_typeof(item->'sort_values') IS DISTINCT FROM 'array'
      OR jsonb_array_length(item->'values') <> jsonb_array_length(p_headers)
      OR jsonb_array_length(item->'sort_values') <> jsonb_array_length(p_headers)
      OR EXISTS (SELECT 1 FROM jsonb_array_elements(item->'sort_values') v
        WHERE jsonb_typeof(v) NOT IN ('null','string','number','boolean')) THEN
      RAISE EXCEPTION 'Malformed sorted report row' USING ERRCODE='22023';
    END IF;
  END LOOP;
  INSERT INTO public.custom_object_report_sort_row(tenant_id,job_id,row_identity,row_values,sort_values)
    SELECT p_tenant_id,p_job_id,value->>'id',value->'values',value->'sort_values'
      FROM jsonb_array_elements(p_rows);
  GET DIAGNOSTICS inserted_count = ROW_COUNT;
  -- Duplicate identities are an error, never an implicit upsert that masks a
  -- broken source cursor. Failed commits roll back the complete page.
  IF NOT p_has_more THEN
    IF jsonb_array_length(j.sort_rules) NOT BETWEEN 1 AND 10 THEN
      RAISE EXCEPTION 'Invalid report sorting' USING ERRCODE='22023';
    END IF;
    FOR rule IN SELECT value FROM jsonb_array_elements(j.sort_rules) LOOP
      IF rule->>'index' !~ '^[0-9]+$' OR COALESCE(rule->>'direction','') NOT IN ('asc','desc') THEN
        RAISE EXCEPTION 'Invalid report sort rule' USING ERRCODE='22023';
      END IF;
      idx := (rule->>'index')::integer;
      IF idx IS NULL OR idx >= jsonb_array_length(p_headers) THEN
        RAISE EXCEPTION 'Sorted column is unavailable' USING ERRCODE='22023';
      END IF;
      direction := upper(rule->>'direction');
      -- Scalar JSONB retains numeric/boolean ordering. Text uses an explicit
      -- C collation; missing/blank keys are NULLS LAST for both directions.
      ordering := ordering || CASE WHEN ordering='' THEN '' ELSE ', ' END ||
        format('(NULLIF(r.sort_values->%s,''null''::jsonb) IS NULL) ASC, ',idx) ||
        format('CASE jsonb_typeof(r.sort_values->%s) WHEN ''number'' THEN 0 WHEN ''boolean'' THEN 1 ELSE 2 END %s, ',idx,direction) ||
        format('(CASE WHEN jsonb_typeof(r.sort_values->%s)=''number'' THEN (r.sort_values->>%s)::numeric END) %s NULLS LAST, ',idx,idx,direction) ||
        format('(CASE WHEN jsonb_typeof(r.sort_values->%s)=''boolean'' THEN (r.sort_values->>%s)::boolean END) %s NULLS LAST, ',idx,idx,direction) ||
        format('(CASE WHEN jsonb_typeof(r.sort_values->%s)=''string'' THEN r.sort_values->>%s END) COLLATE "C" %s NULLS LAST',idx,idx,direction);
    END LOOP;
    EXECUTE format('WITH ranked AS (
      SELECT row_identity,row_number() OVER (ORDER BY %s, r.row_identity COLLATE "C" ASC) AS ordinal
      FROM public.custom_object_report_sort_row r WHERE tenant_id=$1 AND job_id=$2
    ) UPDATE public.custom_object_report_sort_row r SET position=ranked.ordinal FROM ranked
      WHERE r.tenant_id=$1 AND r.job_id=$2 AND r.row_identity=ranked.row_identity',ordering)
      USING p_tenant_id,p_job_id;
  END IF;
  UPDATE public.custom_object_report_sort_job SET
    headers=p_headers,processed=j.processed+inserted_count,total=j.processed+inserted_count,
    next_page=j.next_page+1,cursor_value=p_next_cursor,claim_token=NULL,
    status=CASE WHEN p_has_more THEN 'processing' ELSE 'ready' END,updated_at=now()
    WHERE tenant_id=p_tenant_id AND id=p_job_id RETURNING * INTO j;
  RETURN to_jsonb(j);
END;
$$;
REVOKE ALL ON FUNCTION public.custom_object_report_sort_commit(uuid,uuid,uuid,uuid,integer,jsonb,jsonb,text,boolean) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.custom_object_report_sort_commit(uuid,uuid,uuid,uuid,integer,jsonb,jsonb,text,boolean) TO service_role;
NOTIFY pgrst,'reload schema';
COMMIT;
