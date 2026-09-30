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

REVOKE ALL ON FUNCTION public.custom_object_report_occurrence_page(uuid,uuid,uuid,text,text,uuid,uuid,boolean,integer,integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.custom_object_report_occurrence_page(uuid,uuid,uuid,text,text,uuid,uuid,boolean,integer,integer) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.custom_object_report_occurrence_page(uuid,uuid,uuid,text,text,uuid,uuid,boolean,integer,integer) TO service_role;

NOTIFY pgrst, 'reload schema';