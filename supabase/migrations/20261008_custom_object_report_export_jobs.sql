CREATE TABLE IF NOT EXISTS public.custom_object_report_export_job (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenant(id) ON DELETE CASCADE,
  custom_object_id uuid NOT NULL REFERENCES public.custom_object_definition(id) ON DELETE CASCADE,
  requested_by_member_id uuid,
  requested_by_tenant_user_id uuid,
  definition jsonb NOT NULL,
  filename text NOT NULL,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','processing','complete','failed')),
  processed integer NOT NULL DEFAULT 0,
  total integer NOT NULL DEFAULT 0,
  next_page integer NOT NULL DEFAULT 1,
  chunk_size integer NOT NULL DEFAULT 500 CHECK (chunk_size BETWEEN 1 AND 500),
  chunk_count integer NOT NULL DEFAULT 0,
  cursor_value text,
  claim_token uuid,
  error_message text,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.custom_object_report_export_chunk (
  job_id uuid NOT NULL REFERENCES public.custom_object_report_export_job(id) ON DELETE CASCADE,
  tenant_id uuid NOT NULL REFERENCES public.tenant(id) ON DELETE CASCADE,
  chunk_index integer NOT NULL CHECK (chunk_index >= 0),
  row_count integer NOT NULL CHECK (row_count >= 0),
  csv_text text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (job_id, chunk_index)
);

CREATE INDEX IF NOT EXISTS custom_object_report_export_job_tenant_created
  ON public.custom_object_report_export_job (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS custom_object_report_export_chunk_tenant_job
  ON public.custom_object_report_export_chunk (tenant_id, job_id, chunk_index);

ALTER TABLE public.custom_object_report_export_job ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.custom_object_report_export_chunk ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.custom_object_report_occurrence_page(
  p_tenant_id uuid,
  p_custom_object_id uuid,
  p_relationship_definition_id uuid,
  p_from_side text,
  p_endpoint_kind text,
  p_endpoint_custom_object_id uuid,
  p_after_edge_id uuid,
  p_include_total boolean,
  p_offset integer,
  p_limit integer
) RETURNS jsonb
LANGUAGE sql STABLE
SET search_path = public
AS $$
  WITH eligible AS (
    SELECT edge.*
    FROM public.custom_object_relationship edge
    JOIN public.custom_object_record root
      ON root.id = CASE WHEN p_from_side = 'source' THEN edge.source_record_id ELSE edge.target_record_id END
     AND root.tenant_id = p_tenant_id
     AND root.custom_object_id = p_custom_object_id
     AND root.archived_at IS NULL
    LEFT JOIN public.custom_object_record custom_endpoint
      ON p_endpoint_kind = 'custom_object'
     AND custom_endpoint.id = CASE WHEN p_from_side = 'source' THEN edge.target_record_id ELSE edge.source_record_id END
     AND custom_endpoint.tenant_id = p_tenant_id
     AND custom_endpoint.custom_object_id = p_endpoint_custom_object_id
     AND custom_endpoint.archived_at IS NULL
    LEFT JOIN public.member member_endpoint
      ON p_endpoint_kind = 'member'
     AND member_endpoint.id = CASE WHEN p_from_side = 'source' THEN edge.target_record_id ELSE edge.source_record_id END
     AND member_endpoint.tenant_id = p_tenant_id
    LEFT JOIN public.organization organization_endpoint
      ON p_endpoint_kind = 'organization'
     AND organization_endpoint.id = CASE WHEN p_from_side = 'source' THEN edge.target_record_id ELSE edge.source_record_id END
     AND organization_endpoint.tenant_id = p_tenant_id
    LEFT JOIN public.organization_group group_endpoint
      ON p_endpoint_kind = 'organization_group'
     AND group_endpoint.id = CASE WHEN p_from_side = 'source' THEN edge.target_record_id ELSE edge.source_record_id END
     AND group_endpoint.tenant_id = p_tenant_id
    WHERE edge.tenant_id = p_tenant_id
      AND edge.relationship_definition_id = p_relationship_definition_id
      AND edge.archived_at IS NULL
      AND p_from_side IN ('source', 'target')
      AND (
        (p_endpoint_kind = 'custom_object' AND custom_endpoint.id IS NOT NULL)
        OR (p_endpoint_kind = 'member' AND member_endpoint.id IS NOT NULL)
        OR (p_endpoint_kind = 'organization' AND organization_endpoint.id IS NOT NULL)
        OR (p_endpoint_kind = 'organization_group' AND group_endpoint.id IS NOT NULL)
      )
  ),
  page_candidates AS (
    SELECT *
    FROM eligible
    WHERE p_after_edge_id IS NULL OR id > p_after_edge_id
    ORDER BY id
    OFFSET CASE WHEN p_after_edge_id IS NULL THEN GREATEST(p_offset, 0) ELSE 0 END
    LIMIT LEAST(GREATEST(p_limit, 1), 500) + 1
  ),
  selected AS (
    SELECT * FROM page_candidates ORDER BY id LIMIT LEAST(GREATEST(p_limit, 1), 500)
  )
  SELECT jsonb_build_object(
    'total', CASE WHEN p_include_total THEN (SELECT count(*) FROM eligible) ELSE NULL END,
    'edges', COALESCE((
      SELECT jsonb_agg(to_jsonb(selected_edge) ORDER BY selected_edge.id) FROM selected selected_edge
    ), '[]'::jsonb),
    'has_more', (SELECT count(*) FROM page_candidates) > LEAST(GREATEST(p_limit, 1), 500),
    'last_edge_id', (SELECT id FROM selected ORDER BY id DESC LIMIT 1)
  )
$$;

CREATE OR REPLACE FUNCTION public.custom_object_report_export_commit(
  p_tenant_id uuid,
  p_custom_object_id uuid,
  p_job_id uuid,
  p_claim_token uuid,
  p_chunk_index integer,
  p_row_count integer,
  p_csv_text text,
  p_processed integer,
  p_total integer,
  p_cursor_value text,
  p_complete boolean,
  p_now timestamptz
) RETURNS public.custom_object_report_export_job
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_job public.custom_object_report_export_job%ROWTYPE;
BEGIN
  SELECT * INTO v_job
  FROM public.custom_object_report_export_job
  WHERE id = p_job_id AND tenant_id = p_tenant_id
    AND custom_object_id = p_custom_object_id
    AND claim_token = p_claim_token
  FOR UPDATE;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF v_job.next_page <> p_chunk_index + 1 THEN RETURN NULL; END IF;

  INSERT INTO public.custom_object_report_export_chunk (
    job_id, tenant_id, chunk_index, row_count, csv_text
  ) VALUES (
    p_job_id, p_tenant_id, p_chunk_index, p_row_count, p_csv_text
  )
  ON CONFLICT (job_id, chunk_index) DO UPDATE
    SET row_count = EXCLUDED.row_count, csv_text = EXCLUDED.csv_text;

  UPDATE public.custom_object_report_export_job
  SET status = CASE WHEN p_complete THEN 'complete' ELSE 'processing' END,
      processed = p_processed,
      total = p_total,
      cursor_value = p_cursor_value,
      next_page = next_page + 1,
      chunk_count = GREATEST(chunk_count, p_chunk_index + 1),
      error_message = NULL,
      claim_token = NULL,
      completed_at = CASE WHEN p_complete THEN p_now ELSE completed_at END,
      updated_at = p_now
  WHERE id = p_job_id
  RETURNING * INTO v_job;
  RETURN v_job;
END;
$$;

REVOKE ALL ON FUNCTION public.custom_object_report_occurrence_page(uuid,uuid,uuid,text,text,uuid,uuid,boolean,integer,integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.custom_object_report_export_commit(uuid,uuid,uuid,uuid,integer,integer,text,integer,integer,text,boolean,timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.custom_object_report_occurrence_page(uuid,uuid,uuid,text,text,uuid,uuid,boolean,integer,integer) FROM anon, authenticated;
REVOKE ALL ON FUNCTION public.custom_object_report_export_commit(uuid,uuid,uuid,uuid,integer,integer,text,integer,integer,text,boolean,timestamptz) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.custom_object_report_occurrence_page(uuid,uuid,uuid,text,text,uuid,uuid,boolean,integer,integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.custom_object_report_export_commit(uuid,uuid,uuid,uuid,integer,integer,text,integer,integer,text,boolean,timestamptz) TO service_role;

NOTIFY pgrst, 'reload schema';