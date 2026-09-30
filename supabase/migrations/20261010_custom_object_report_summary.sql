CREATE INDEX IF NOT EXISTS custom_object_report_relationship_source_order
  ON public.custom_object_relationship (
    tenant_id, relationship_definition_id, source_record_id, id
  ) WHERE archived_at IS NULL;

CREATE INDEX IF NOT EXISTS custom_object_report_relationship_target_order
  ON public.custom_object_relationship (
    tenant_id, relationship_definition_id, target_record_id, id
  ) WHERE archived_at IS NULL;

CREATE INDEX IF NOT EXISTS custom_object_report_member_root_order
  ON public.member (tenant_id, id);

CREATE INDEX IF NOT EXISTS custom_object_report_organization_root_order
  ON public.organization (tenant_id, id);

CREATE INDEX IF NOT EXISTS custom_object_report_organization_group_root_order
  ON public.organization_group (tenant_id, id);

CREATE OR REPLACE FUNCTION public.custom_object_report_summary_page(
  p_tenant_id uuid,
  p_start_kind text,
  p_start_custom_object_id uuid,
  p_grain_path jsonb,
  p_include_empty boolean,
  p_offset integer,
  p_limit integer,
  p_after_cursor text,
  p_include_total boolean
) RETURNS jsonb
LANGUAGE plpgsql STABLE
SET search_path = public
AS $$
DECLARE
  v_hop jsonb;
  v_definition public.custom_object_relationship_definition%ROWTYPE;
  v_current_kind text := p_start_kind;
  v_current_object_id uuid := p_start_custom_object_id;
  v_definition_id uuid;
  v_from_side text;
  v_endpoint_kind text;
  v_endpoint_object_id uuid;
  v_root_table text;
  v_from_column text;
  v_to_column text;
  v_endpoint_table text;
  v_joins text := '';
  v_record_ids text := 'jsonb_build_array(to_jsonb(r.id))';
  v_edges text := '''[]''::jsonb';
  v_occurrence_id text := 'r.id::text';
  v_order_by text := 'sort_root';
  v_order_by_desc text := 'sort_root DESC';
  v_cursor_predicate text := 'true';
  v_cursor_parts text[];
  v_cursor_root uuid;
  v_cursor_edges uuid[] := ARRAY[]::uuid[];
  v_root_cursor_predicate text := '';
  v_cursor_level integer;
  v_prefix_level integer;
  v_previous_record text := 'r.id';
  v_terminal_record text := 'r.id';
  v_root_predicate text := '';
  v_query text;
  v_total numeric;
  v_result jsonb;
  v_hop_number integer := 0;
  v_page_limit integer := LEAST(GREATEST(COALESCE(p_limit, 1), 1), 500);
  v_page_offset integer := GREATEST(COALESCE(p_offset, 0), 0);
BEGIN
  IF p_tenant_id IS NULL
    OR NOT EXISTS (SELECT 1 FROM public.tenant WHERE id = p_tenant_id)
    OR p_start_kind NOT IN ('custom_object', 'member', 'organization', 'organization_group')
    OR (p_start_kind = 'custom_object') IS DISTINCT FROM (p_start_custom_object_id IS NOT NULL)
    OR p_grain_path IS NULL
    OR jsonb_typeof(p_grain_path) <> 'array'
    OR jsonb_array_length(p_grain_path) > 6
  THEN
    RAISE EXCEPTION 'Invalid custom object report summary input' USING ERRCODE = '22023';
  END IF;

  IF p_start_kind = 'custom_object' AND NOT EXISTS (
    SELECT 1
    FROM public.custom_object_definition
    WHERE tenant_id = p_tenant_id
      AND id = p_start_custom_object_id
      AND status = 'active'
  ) THEN
    RAISE EXCEPTION 'Invalid custom object report summary start schema' USING ERRCODE = '22023';
  END IF;

  v_root_table := CASE p_start_kind
    WHEN 'custom_object' THEN 'custom_object_record'
    WHEN 'member' THEN 'member'
    WHEN 'organization' THEN 'organization'
    WHEN 'organization_group' THEN 'organization_group'
  END;

  IF p_start_kind = 'custom_object' THEN
    v_root_predicate := format(
      ' AND r.custom_object_id = %L::uuid AND r.archived_at IS NULL',
      p_start_custom_object_id
    );
  END IF;

  FOR v_hop IN SELECT value FROM jsonb_array_elements(p_grain_path)
  LOOP
    v_hop_number := v_hop_number + 1;
    IF jsonb_typeof(v_hop) <> 'object' THEN
      RAISE EXCEPTION 'Invalid custom object report summary hop' USING ERRCODE = '22023';
    END IF;

    BEGIN
      v_definition_id := (v_hop->>'relationship_definition_id')::uuid;
      v_from_side := v_hop->>'from_side';
      v_endpoint_kind := v_hop->>'endpoint_kind';
      v_endpoint_object_id := NULLIF(v_hop->>'endpoint_custom_object_id', '')::uuid;
    EXCEPTION WHEN invalid_text_representation THEN
      RAISE EXCEPTION 'Invalid custom object report summary hop' USING ERRCODE = '22023';
    END;

    SELECT *
      INTO v_definition
      FROM public.custom_object_relationship_definition
     WHERE tenant_id = p_tenant_id
       AND id = v_definition_id
       AND status = 'active'
       AND archived_at IS NULL;

    IF NOT FOUND
      OR v_from_side IS NULL
      OR v_from_side NOT IN ('source', 'target')
      OR v_endpoint_kind IS NULL
      OR v_endpoint_kind NOT IN ('custom_object', 'member', 'organization', 'organization_group')
      OR (v_endpoint_kind = 'custom_object') IS DISTINCT FROM (v_endpoint_object_id IS NOT NULL)
      OR (
        v_endpoint_kind = 'custom_object'
        AND NOT EXISTS (
          SELECT 1
          FROM public.custom_object_definition endpoint_definition
          WHERE endpoint_definition.tenant_id = p_tenant_id
            AND endpoint_definition.id = v_endpoint_object_id
            AND endpoint_definition.status = 'active'
        )
      )
      OR (
        v_from_side = 'source'
        AND (
          v_definition.source_kind IS DISTINCT FROM v_current_kind
          OR v_definition.source_custom_object_id IS DISTINCT FROM v_current_object_id
          OR v_definition.target_kind IS DISTINCT FROM v_endpoint_kind
          OR v_definition.target_custom_object_id IS DISTINCT FROM v_endpoint_object_id
        )
      )
      OR (
        v_from_side = 'target'
        AND (
          v_definition.target_kind IS DISTINCT FROM v_current_kind
          OR v_definition.target_custom_object_id IS DISTINCT FROM v_current_object_id
          OR v_definition.source_kind IS DISTINCT FROM v_endpoint_kind
          OR v_definition.source_custom_object_id IS DISTINCT FROM v_endpoint_object_id
        )
      )
    THEN
      RAISE EXCEPTION 'Invalid custom object report summary path schema' USING ERRCODE = '22023';
    END IF;

    v_from_column := CASE v_from_side WHEN 'source' THEN 'source_record_id' ELSE 'target_record_id' END;
    v_to_column := CASE v_from_side WHEN 'source' THEN 'target_record_id' ELSE 'source_record_id' END;
    v_endpoint_table := CASE v_endpoint_kind
      WHEN 'custom_object' THEN 'custom_object_record'
      WHEN 'member' THEN 'member'
      WHEN 'organization' THEN 'organization'
      WHEN 'organization_group' THEN 'organization_group'
    END;

    v_joins := v_joins || format(
      ' LEFT JOIN LATERAL (
          SELECT e.id AS edge_id, e.%1$I AS record_id, to_jsonb(e) AS edge_json
          FROM public.custom_object_relationship e
          WHERE e.tenant_id = $1
            AND e.relationship_definition_id = %4$L::uuid
            AND e.archived_at IS NULL
            AND e.%5$I = %6$s
            AND (
              SELECT endpoint.id
              FROM public.%2$I endpoint
              WHERE endpoint.id = e.%1$I
                AND endpoint.tenant_id = $1
                %3$s
              LIMIT 1
            ) IS NOT NULL
            /*CUSTOM_REPORT_CURSOR_HOP_%7$s*/
          ORDER BY e.id
        ) h%7$s ON %6$s IS NOT NULL',
      v_to_column,
      v_endpoint_table,
      CASE WHEN v_endpoint_kind = 'custom_object' THEN format(
        'AND endpoint.custom_object_id = %L::uuid AND endpoint.archived_at IS NULL',
        v_endpoint_object_id
      ) ELSE '' END,
      v_definition_id,
      v_from_column,
      v_previous_record,
      v_hop_number
    );

    v_previous_record := format('h%s.record_id', v_hop_number);
    v_terminal_record := v_previous_record;
    v_record_ids := v_record_ids || format(
      ' || jsonb_build_array(to_jsonb(h%s.record_id))',
      v_hop_number
    );
    v_edges := v_edges || format(
      ' || jsonb_build_array(CASE WHEN h%1$s.edge_id IS NULL THEN ''null''::jsonb ELSE h%1$s.edge_json END)',
      v_hop_number
    );
    v_occurrence_id := v_occurrence_id || format(
      ' || ''/'' || COALESCE(h%s.edge_id::text, ''-'')',
      v_hop_number
    );
    v_order_by := v_order_by || format(', sort_edge_%s NULLS FIRST', v_hop_number);
    v_order_by_desc := v_order_by_desc ||
      format(', sort_edge_%s DESC NULLS LAST', v_hop_number);
    v_current_kind := v_endpoint_kind;
    v_current_object_id := v_endpoint_object_id;
  END LOOP;

  IF p_after_cursor IS NOT NULL THEN
    v_cursor_parts := string_to_array(p_after_cursor, '/');
    IF cardinality(v_cursor_parts) <> v_hop_number + 1 THEN
      RAISE EXCEPTION 'Invalid custom object report summary cursor' USING ERRCODE = '22023';
    END IF;
    BEGIN
      v_cursor_root := v_cursor_parts[1]::uuid;
      FOR v_cursor_level IN 1..(cardinality(v_cursor_parts) - 1)
      LOOP
        IF v_cursor_parts[v_cursor_level + 1] = '-' THEN
          v_cursor_edges := array_append(v_cursor_edges, NULL::uuid);
        ELSE
          v_cursor_edges := array_append(
            v_cursor_edges,
            v_cursor_parts[v_cursor_level + 1]::uuid
          );
        END IF;
      END LOOP;
    EXCEPTION WHEN invalid_text_representation THEN
      RAISE EXCEPTION 'Invalid custom object report summary cursor' USING ERRCODE = '22023';
    END;

    v_root_cursor_predicate := format(' AND r.id >= %L::uuid', v_cursor_root);
    v_cursor_predicate := format('sort_root > %L::uuid', v_cursor_root);
    FOR v_cursor_level IN 1..cardinality(v_cursor_edges)
    LOOP
      v_cursor_predicate := v_cursor_predicate || ' OR (' ||
        format('sort_root = %L::uuid', v_cursor_root);
      IF v_cursor_level > 1 THEN
        FOR v_prefix_level IN 1..(v_cursor_level - 1)
        LOOP
          v_cursor_predicate := v_cursor_predicate || format(
            ' AND sort_edge_%s IS NOT DISTINCT FROM %L::uuid',
            v_prefix_level,
            v_cursor_edges[v_prefix_level]
          );
        END LOOP;
      END IF;
      v_cursor_predicate := v_cursor_predicate || CASE
        WHEN v_cursor_edges[v_cursor_level] IS NULL THEN
          format(' AND sort_edge_%s IS NOT NULL)', v_cursor_level)
        ELSE
          format(
            ' AND sort_edge_%s > %L::uuid)',
            v_cursor_level,
            v_cursor_edges[v_cursor_level]
          )
      END;

      IF v_cursor_edges[v_cursor_level] IS NOT NULL THEN
        v_query := format('r.id = %L::uuid', v_cursor_root);
        IF v_cursor_level > 1 THEN
          FOR v_prefix_level IN 1..(v_cursor_level - 1)
          LOOP
            v_query := v_query || format(
              ' AND h%s.edge_id IS NOT DISTINCT FROM %L::uuid',
              v_prefix_level,
              v_cursor_edges[v_prefix_level]
            );
          END LOOP;
        END IF;
        v_joins := replace(
          v_joins,
          format('/*CUSTOM_REPORT_CURSOR_HOP_%s*/', v_cursor_level),
          format(
            'AND e.id >= CASE WHEN %s THEN %L::uuid ELSE ''00000000-0000-0000-0000-000000000000''::uuid END',
            v_query,
            v_cursor_edges[v_cursor_level]
          )
        );
      END IF;
    END LOOP;
  END IF;
  v_joins := regexp_replace(
    v_joins,
    '/\*CUSTOM_REPORT_CURSOR_HOP_[0-9]+\*/',
    '',
    'g'
  );

  v_query := format(
    'SELECT %1$s AS id, %2$s AS record_ids, %3$s AS edges, %4$s AS terminal_record,
            r.id AS sort_root %8$s
       FROM (
         SELECT *
         FROM public.%5$I root_scan
         WHERE root_scan.tenant_id = $1 %7$s %9$s
         ORDER BY root_scan.id
         OFFSET 0
       ) r
       %6$s
      WHERE ($5 OR %4$s IS NOT NULL)',
    v_occurrence_id,
    v_record_ids,
    v_edges,
    v_terminal_record,
    v_root_table,
    v_joins,
    replace(v_root_predicate, 'r.', 'root_scan.'),
    (SELECT COALESCE(string_agg(
      format(', h%s.edge_id AS sort_edge_%s', n, n), '' ORDER BY n
    ), '') FROM generate_series(1, v_hop_number) n),
    replace(v_root_cursor_predicate, 'r.', 'root_scan.')
  );

  IF COALESCE(p_include_total, false) THEN
    EXECUTE 'SELECT count(*)::numeric FROM (' || v_query || ') occurrences'
      INTO v_total
      USING p_tenant_id, p_after_cursor, v_page_offset, v_page_limit, COALESCE(p_include_empty, false);
  END IF;

  EXECUTE
    'WITH candidates AS (
       SELECT *
       FROM (' || v_query || ') occurrences
       WHERE ($2 IS NULL OR (' || v_cursor_predicate || '))
       OFFSET CASE WHEN $2 IS NULL THEN $3 ELSE 0 END
       LIMIT $4 + 1
     ),
     selected AS (
       SELECT * FROM candidates ORDER BY ' || v_order_by || ' LIMIT $4
     )
     SELECT jsonb_build_object(
       ''rows'', COALESCE(
         (SELECT jsonb_agg(jsonb_build_object(
           ''id'', id, ''record_ids'', record_ids, ''edges'', edges
         ) ORDER BY ' || v_order_by || ') FROM selected),
         ''[]''::jsonb
       ),
       ''has_more'', (SELECT count(*) FROM candidates) > $4,
       ''last_cursor'', (SELECT id FROM selected ORDER BY ' || v_order_by_desc || ' LIMIT 1)
     )'
    INTO v_result
    USING p_tenant_id, p_after_cursor, v_page_offset, v_page_limit, COALESCE(p_include_empty, false);

  RETURN jsonb_build_object(
    'total', v_total,
    'rows', v_result->'rows',
    'has_more', v_result->'has_more',
    'last_cursor', v_result->'last_cursor'
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.custom_object_report_distinct_count(
  p_tenant_id uuid,
  p_start_kind text,
  p_start_custom_object_id uuid,
  p_start_record_id uuid,
  p_path jsonb
) RETURNS numeric
LANGUAGE plpgsql STABLE
SET search_path = public
AS $$
DECLARE
  v_hop jsonb;
  v_definition public.custom_object_relationship_definition%ROWTYPE;
  v_current_kind text := p_start_kind;
  v_current_object_id uuid := p_start_custom_object_id;
  v_definition_id uuid;
  v_from_side text;
  v_endpoint_kind text;
  v_endpoint_object_id uuid;
  v_root_table text;
  v_from_column text;
  v_to_column text;
  v_endpoint_table text;
  v_joins text := '';
  v_previous_record text := 'r.id';
  v_terminal_record text := 'r.id';
  v_root_predicate text := '';
  v_query text;
  v_result numeric;
  v_hop_number integer := 0;
BEGIN
  IF p_tenant_id IS NULL
    OR p_start_record_id IS NULL
    OR NOT EXISTS (SELECT 1 FROM public.tenant WHERE id = p_tenant_id)
    OR p_start_kind NOT IN ('custom_object', 'member', 'organization', 'organization_group')
    OR (p_start_kind = 'custom_object') IS DISTINCT FROM (p_start_custom_object_id IS NOT NULL)
    OR p_path IS NULL
    OR jsonb_typeof(p_path) <> 'array'
    OR jsonb_array_length(p_path) > 6
  THEN
    RAISE EXCEPTION 'Invalid custom object report distinct count input' USING ERRCODE = '22023';
  END IF;

  IF p_start_kind = 'custom_object' AND NOT EXISTS (
    SELECT 1 FROM public.custom_object_definition
    WHERE tenant_id = p_tenant_id
      AND id = p_start_custom_object_id
      AND status = 'active'
  ) THEN
    RAISE EXCEPTION 'Invalid custom object report distinct count start schema' USING ERRCODE = '22023';
  END IF;

  v_root_table := CASE p_start_kind
    WHEN 'custom_object' THEN 'custom_object_record'
    WHEN 'member' THEN 'member'
    WHEN 'organization' THEN 'organization'
    WHEN 'organization_group' THEN 'organization_group'
  END;
  IF p_start_kind = 'custom_object' THEN
    v_root_predicate := format(
      ' AND r.custom_object_id = %L::uuid AND r.archived_at IS NULL',
      p_start_custom_object_id
    );
  END IF;

  FOR v_hop IN SELECT value FROM jsonb_array_elements(p_path)
  LOOP
    v_hop_number := v_hop_number + 1;
    IF jsonb_typeof(v_hop) <> 'object' THEN
      RAISE EXCEPTION 'Invalid custom object report distinct count hop' USING ERRCODE = '22023';
    END IF;
    BEGIN
      v_definition_id := (v_hop->>'relationship_definition_id')::uuid;
      v_from_side := v_hop->>'from_side';
      v_endpoint_kind := v_hop->>'endpoint_kind';
      v_endpoint_object_id := NULLIF(v_hop->>'endpoint_custom_object_id', '')::uuid;
    EXCEPTION WHEN invalid_text_representation THEN
      RAISE EXCEPTION 'Invalid custom object report distinct count hop' USING ERRCODE = '22023';
    END;

    SELECT * INTO v_definition
    FROM public.custom_object_relationship_definition
    WHERE tenant_id = p_tenant_id
      AND id = v_definition_id
      AND status = 'active'
      AND archived_at IS NULL;

    IF NOT FOUND
      OR v_from_side IS NULL
      OR v_from_side NOT IN ('source', 'target')
      OR v_endpoint_kind IS NULL
      OR v_endpoint_kind NOT IN ('custom_object', 'member', 'organization', 'organization_group')
      OR (v_endpoint_kind = 'custom_object') IS DISTINCT FROM (v_endpoint_object_id IS NOT NULL)
      OR (
        v_endpoint_kind = 'custom_object'
        AND NOT EXISTS (
          SELECT 1
          FROM public.custom_object_definition endpoint_definition
          WHERE endpoint_definition.tenant_id = p_tenant_id
            AND endpoint_definition.id = v_endpoint_object_id
            AND endpoint_definition.status = 'active'
        )
      )
      OR (v_from_side = 'source' AND (
        v_definition.source_kind IS DISTINCT FROM v_current_kind
        OR v_definition.source_custom_object_id IS DISTINCT FROM v_current_object_id
        OR v_definition.target_kind IS DISTINCT FROM v_endpoint_kind
        OR v_definition.target_custom_object_id IS DISTINCT FROM v_endpoint_object_id
      ))
      OR (v_from_side = 'target' AND (
        v_definition.target_kind IS DISTINCT FROM v_current_kind
        OR v_definition.target_custom_object_id IS DISTINCT FROM v_current_object_id
        OR v_definition.source_kind IS DISTINCT FROM v_endpoint_kind
        OR v_definition.source_custom_object_id IS DISTINCT FROM v_endpoint_object_id
      ))
    THEN
      RAISE EXCEPTION 'Invalid custom object report distinct count path schema' USING ERRCODE = '22023';
    END IF;

    v_from_column := CASE v_from_side WHEN 'source' THEN 'source_record_id' ELSE 'target_record_id' END;
    v_to_column := CASE v_from_side WHEN 'source' THEN 'target_record_id' ELSE 'source_record_id' END;
    v_endpoint_table := CASE v_endpoint_kind
      WHEN 'custom_object' THEN 'custom_object_record'
      WHEN 'member' THEN 'member'
      WHEN 'organization' THEN 'organization'
      WHEN 'organization_group' THEN 'organization_group'
    END;
    v_joins := v_joins || format(
      ' JOIN LATERAL (
          SELECT e.%1$I AS record_id
          FROM public.custom_object_relationship e
          JOIN public.%2$I endpoint
            ON endpoint.id = e.%1$I
           AND endpoint.tenant_id = $1
           %3$s
          WHERE e.tenant_id = $1
            AND e.relationship_definition_id = %4$L::uuid
            AND e.archived_at IS NULL
            AND e.%5$I = %6$s
        ) h%7$s ON true',
      v_to_column,
      v_endpoint_table,
      CASE WHEN v_endpoint_kind = 'custom_object' THEN format(
        'AND endpoint.custom_object_id = %L::uuid AND endpoint.archived_at IS NULL',
        v_endpoint_object_id
      ) ELSE '' END,
      v_definition_id,
      v_from_column,
      v_previous_record,
      v_hop_number
    );
    v_previous_record := format('h%s.record_id', v_hop_number);
    v_terminal_record := v_previous_record;
    v_current_kind := v_endpoint_kind;
    v_current_object_id := v_endpoint_object_id;
  END LOOP;

  v_query := format(
    'SELECT count(DISTINCT %1$s)::numeric
       FROM public.%2$I r
       %3$s
      WHERE r.tenant_id = $1
        AND r.id = $2
        %4$s',
    v_terminal_record,
    v_root_table,
    v_joins,
    v_root_predicate
  );
  EXECUTE v_query INTO v_result USING p_tenant_id, p_start_record_id;
  RETURN v_result;
END;
$$;

CREATE OR REPLACE FUNCTION public.custom_object_report_distinct_counts(
  p_tenant_id uuid,
  p_start_kind text,
  p_start_custom_object_id uuid,
  p_start_record_ids uuid[],
  p_path jsonb
) RETURNS jsonb
LANGUAGE plpgsql STABLE
SET search_path = public
AS $$
DECLARE
  v_hop jsonb;
  v_definition public.custom_object_relationship_definition%ROWTYPE;
  v_current_kind text := p_start_kind;
  v_current_object_id uuid := p_start_custom_object_id;
  v_definition_id uuid;
  v_from_side text;
  v_endpoint_kind text;
  v_endpoint_object_id uuid;
  v_root_table text;
  v_from_column text;
  v_to_column text;
  v_endpoint_table text;
  v_joins text := '';
  v_previous_record text := 'r.id';
  v_terminal_record text := 'r.id';
  v_root_predicate text := '';
  v_query text;
  v_result jsonb;
  v_hop_number integer := 0;
BEGIN
  IF p_tenant_id IS NULL
    OR p_start_record_ids IS NULL
    OR cardinality(p_start_record_ids) > 500
    OR array_position(p_start_record_ids, NULL::uuid) IS NOT NULL
    OR NOT EXISTS (SELECT 1 FROM public.tenant WHERE id = p_tenant_id)
    OR p_start_kind NOT IN ('custom_object', 'member', 'organization', 'organization_group')
    OR (p_start_kind = 'custom_object') IS DISTINCT FROM (p_start_custom_object_id IS NOT NULL)
    OR p_path IS NULL
    OR jsonb_typeof(p_path) <> 'array'
    OR jsonb_array_length(p_path) > 6
  THEN
    RAISE EXCEPTION 'Invalid custom object report distinct counts input' USING ERRCODE = '22023';
  END IF;

  IF p_start_kind = 'custom_object' AND NOT EXISTS (
    SELECT 1 FROM public.custom_object_definition
    WHERE tenant_id = p_tenant_id
      AND id = p_start_custom_object_id
      AND status = 'active'
  ) THEN
    RAISE EXCEPTION 'Invalid custom object report distinct counts start schema' USING ERRCODE = '22023';
  END IF;

  v_root_table := CASE p_start_kind
    WHEN 'custom_object' THEN 'custom_object_record'
    WHEN 'member' THEN 'member'
    WHEN 'organization' THEN 'organization'
    WHEN 'organization_group' THEN 'organization_group'
  END;
  IF p_start_kind = 'custom_object' THEN
    v_root_predicate := format(
      ' AND r.custom_object_id = %L::uuid AND r.archived_at IS NULL',
      p_start_custom_object_id
    );
  END IF;

  FOR v_hop IN SELECT value FROM jsonb_array_elements(p_path)
  LOOP
    v_hop_number := v_hop_number + 1;
    IF jsonb_typeof(v_hop) <> 'object' THEN
      RAISE EXCEPTION 'Invalid custom object report distinct counts hop' USING ERRCODE = '22023';
    END IF;
    BEGIN
      v_definition_id := (v_hop->>'relationship_definition_id')::uuid;
      v_from_side := v_hop->>'from_side';
      v_endpoint_kind := v_hop->>'endpoint_kind';
      v_endpoint_object_id := NULLIF(v_hop->>'endpoint_custom_object_id', '')::uuid;
    EXCEPTION WHEN invalid_text_representation THEN
      RAISE EXCEPTION 'Invalid custom object report distinct counts hop' USING ERRCODE = '22023';
    END;

    SELECT * INTO v_definition
    FROM public.custom_object_relationship_definition
    WHERE tenant_id = p_tenant_id
      AND id = v_definition_id
      AND status = 'active'
      AND archived_at IS NULL;

    IF NOT FOUND
      OR v_from_side IS NULL
      OR v_from_side NOT IN ('source', 'target')
      OR v_endpoint_kind IS NULL
      OR v_endpoint_kind NOT IN ('custom_object', 'member', 'organization', 'organization_group')
      OR (v_endpoint_kind = 'custom_object') IS DISTINCT FROM (v_endpoint_object_id IS NOT NULL)
      OR (v_endpoint_kind = 'custom_object' AND NOT EXISTS (
        SELECT 1 FROM public.custom_object_definition endpoint_definition
        WHERE endpoint_definition.tenant_id = p_tenant_id
          AND endpoint_definition.id = v_endpoint_object_id
          AND endpoint_definition.status = 'active'
      ))
      OR (v_from_side = 'source' AND (
        v_definition.source_kind IS DISTINCT FROM v_current_kind
        OR v_definition.source_custom_object_id IS DISTINCT FROM v_current_object_id
        OR v_definition.target_kind IS DISTINCT FROM v_endpoint_kind
        OR v_definition.target_custom_object_id IS DISTINCT FROM v_endpoint_object_id
      ))
      OR (v_from_side = 'target' AND (
        v_definition.target_kind IS DISTINCT FROM v_current_kind
        OR v_definition.target_custom_object_id IS DISTINCT FROM v_current_object_id
        OR v_definition.source_kind IS DISTINCT FROM v_endpoint_kind
        OR v_definition.source_custom_object_id IS DISTINCT FROM v_endpoint_object_id
      ))
    THEN
      RAISE EXCEPTION 'Invalid custom object report distinct counts path schema' USING ERRCODE = '22023';
    END IF;

    v_from_column := CASE v_from_side WHEN 'source' THEN 'source_record_id' ELSE 'target_record_id' END;
    v_to_column := CASE v_from_side WHEN 'source' THEN 'target_record_id' ELSE 'source_record_id' END;
    v_endpoint_table := CASE v_endpoint_kind
      WHEN 'custom_object' THEN 'custom_object_record'
      WHEN 'member' THEN 'member'
      WHEN 'organization' THEN 'organization'
      WHEN 'organization_group' THEN 'organization_group'
    END;
    v_joins := v_joins || format(
      ' JOIN LATERAL (
          SELECT e.%1$I AS record_id
          FROM public.custom_object_relationship e
          JOIN public.%2$I endpoint
            ON endpoint.id = e.%1$I
           AND endpoint.tenant_id = $1
           %3$s
          WHERE e.tenant_id = $1
            AND e.relationship_definition_id = %4$L::uuid
            AND e.archived_at IS NULL
            AND e.%5$I = %6$s
        ) h%7$s ON true',
      v_to_column,
      v_endpoint_table,
      CASE WHEN v_endpoint_kind = 'custom_object' THEN format(
        'AND endpoint.custom_object_id = %L::uuid AND endpoint.archived_at IS NULL',
        v_endpoint_object_id
      ) ELSE '' END,
      v_definition_id,
      v_from_column,
      v_previous_record,
      v_hop_number
    );
    v_previous_record := format('h%s.record_id', v_hop_number);
    v_terminal_record := v_previous_record;
    v_current_kind := v_endpoint_kind;
    v_current_object_id := v_endpoint_object_id;
  END LOOP;

  v_query := format(
    'WITH requested AS (
       SELECT record_id, ordinal
       FROM unnest($2::uuid[]) WITH ORDINALITY requested(record_id, ordinal)
     ),
     eligible_counts AS (
       SELECT r.id AS record_id, count(DISTINCT %1$s)::numeric AS distinct_count
       FROM public.%2$I r
       %3$s
       WHERE r.tenant_id = $1
         AND r.id = ANY($2)
         %4$s
       GROUP BY r.id
     )
     SELECT COALESCE(jsonb_agg(
       jsonb_build_object(
         ''record_id'', requested.record_id,
         ''count'', COALESCE(eligible_counts.distinct_count, 0)
       ) ORDER BY requested.ordinal
     ), ''[]''::jsonb)
     FROM requested
     LEFT JOIN eligible_counts USING (record_id)',
    v_terminal_record,
    v_root_table,
    v_joins,
    v_root_predicate
  );
  EXECUTE v_query INTO v_result USING p_tenant_id, p_start_record_ids;
  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION public.custom_object_report_summary_page(uuid,text,uuid,jsonb,boolean,integer,integer,text,boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.custom_object_report_summary_page(uuid,text,uuid,jsonb,boolean,integer,integer,text,boolean) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.custom_object_report_summary_page(uuid,text,uuid,jsonb,boolean,integer,integer,text,boolean) TO service_role;

REVOKE ALL ON FUNCTION public.custom_object_report_distinct_count(uuid,text,uuid,uuid,jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.custom_object_report_distinct_count(uuid,text,uuid,uuid,jsonb) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.custom_object_report_distinct_count(uuid,text,uuid,uuid,jsonb) TO service_role;

REVOKE ALL ON FUNCTION public.custom_object_report_distinct_counts(uuid,text,uuid,uuid[],jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.custom_object_report_distinct_counts(uuid,text,uuid,uuid[],jsonb) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.custom_object_report_distinct_counts(uuid,text,uuid,uuid[],jsonb) TO service_role;

NOTIFY pgrst, 'reload schema';