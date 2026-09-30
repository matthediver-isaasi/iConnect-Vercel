-- Performs relationship list predicates, ordering, exact count and paging in
-- PostgreSQL.  The API intentionally projects record data only after this
-- bounded selector has returned the requested IDs.
CREATE OR REPLACE FUNCTION public.custom_object_record_relationship_list(
  p_tenant_id uuid,
  p_custom_object_id uuid,
  p_include_archived boolean DEFAULT false,
  p_scalar_plan jsonb DEFAULT '{}'::jsonb,
  p_filters jsonb DEFAULT '[]'::jsonb,
  p_sort jsonb DEFAULT NULL,
  p_offset integer DEFAULT 0,
  p_limit integer DEFAULT 100
)
RETURNS TABLE(record_id uuid, total_count bigint)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  f jsonb;
  sf jsonb;
  where_sql text := '';
  order_sql text := 'sort_value ASC NULLS LAST, id ASC';
  definition_id uuid;
  routed_side text;
  opposite_column text;
  routed_column text;
  value_ids uuid[];
  endpoint_object uuid;
  endpoint_kind text;
  display_key text;
  clause text;
  sort_expression text;
  scalar_key text;
  scalar_columns text;
  scalar_kind text;
  scalar_operator text;
BEGIN
  IF p_limit < 1 OR p_limit > 1000 OR p_offset < 0 THEN
    RAISE EXCEPTION 'Invalid relationship list range' USING ERRCODE = '22023';
  END IF;
  IF p_filters IS NULL OR jsonb_typeof(p_filters) <> 'array' THEN
    RAISE EXCEPTION 'Relationship filters must be an array' USING ERRCODE = '22023';
  END IF;
  IF p_scalar_plan IS NULL OR jsonb_typeof(p_scalar_plan) <> 'object' THEN
    RAISE EXCEPTION 'Scalar list plan must be an object' USING ERRCODE = '22023';
  END IF;
  -- Scalar criteria are serialized from the same whitelist-only service plan.
  -- Validate every key against the active object schema as well: this function
  -- is SECURITY DEFINER and must not rely on its caller to enforce metadata.
  FOR sf IN SELECT value FROM jsonb_array_elements(COALESCE(p_scalar_plan->'filters', '[]'::jsonb)) LOOP
    scalar_key := substring(COALESCE(sf->>'textColumn', sf->>'column') FROM '([a-z][a-z0-9_]*)$');
    scalar_kind := sf->>'kind';
    scalar_operator := sf->>'op';
    IF scalar_key IS NULL OR NOT EXISTS (
      SELECT 1
      FROM preference_field pf
      WHERE pf.tenant_id = p_tenant_id
        AND pf.custom_object_id = p_custom_object_id
        AND pf.entity_scope = 'custom_object'
        AND pf.is_active = true
        AND pf.name = scalar_key
    ) THEN
      RAISE EXCEPTION 'Invalid scalar list filter' USING ERRCODE = '22023';
    END IF;
    IF scalar_kind = 'filter' AND scalar_operator = 'ilike' THEN
      where_sql := where_sql || format(
        ' AND (r.data->>%L) ILIKE %L',
        scalar_key,
        replace(COALESCE(sf->>'value', ''), '*', '%')
      );
    ELSIF scalar_kind = 'filter'
      AND scalar_operator = 'eq'
      AND sf->>'column' LIKE 'data->>%' THEN
      where_sql := where_sql || format(
        ' AND (r.data->>%L) = %L',
        scalar_key,
        COALESCE(sf->>'value', '')
      );
    ELSIF scalar_kind = 'filter' AND scalar_operator IN ('eq', 'gte', 'lte') THEN
      where_sql := where_sql || format(
        ' AND (r.data->%L) %s %L::jsonb',
        scalar_key,
        CASE scalar_operator WHEN 'eq' THEN '=' WHEN 'gte' THEN '>=' ELSE '<=' END,
        COALESCE(sf->>'value', 'null')
      );
    ELSIF scalar_kind = 'is_empty' THEN
      where_sql := where_sql || format(' AND COALESCE(r.data->>%L, '''') = ''''', scalar_key);
    ELSIF scalar_kind = 'is_not_empty' THEN
      where_sql := where_sql || format(' AND COALESCE(r.data->>%L, '''') <> ''''', scalar_key);
    ELSIF scalar_kind IN ('any_of_scalar', 'none_of_scalar') THEN
      where_sql := where_sql || format(' AND %s(r.data->>%L = ANY(%L::text[]))',
        CASE WHEN scalar_kind = 'none_of_scalar' THEN 'NOT ' ELSE '' END, scalar_key,
        ARRAY(SELECT jsonb_array_elements_text(sf->'values')));
    ELSIF scalar_kind IN ('any_of_array', 'none_of_array') THEN
      where_sql := where_sql || format(
        ' AND %sEXISTS (SELECT 1 FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(r.data->%L) = ''array'' THEN r.data->%L ELSE ''[]''::jsonb END) av(value) WHERE av.value = ANY(%L::text[]))',
        CASE WHEN scalar_kind = 'none_of_array' THEN 'NOT ' ELSE '' END,
        scalar_key,
        scalar_key,
        ARRAY(SELECT jsonb_array_elements_text(sf->'values'))
      );
    ELSE
      RAISE EXCEPTION 'Unsupported scalar list filter' USING ERRCODE = '22023';
    END IF;
  END LOOP;
  IF COALESCE(p_scalar_plan->>'search', '') <> '' THEN
    FOR scalar_key IN
      SELECT substring(value FROM '([a-z][a-z0-9_]*)$')
      FROM jsonb_array_elements_text(COALESCE(p_scalar_plan->'searchable_columns', '[]'::jsonb))
    LOOP
      IF scalar_key IS NULL OR NOT EXISTS (
        SELECT 1
        FROM preference_field pf
        WHERE pf.tenant_id = p_tenant_id
          AND pf.custom_object_id = p_custom_object_id
          AND pf.entity_scope = 'custom_object'
          AND pf.is_active = true
          AND pf.name = scalar_key
      ) THEN
        RAISE EXCEPTION 'Invalid scalar search field' USING ERRCODE = '22023';
      END IF;
    END LOOP;
    scalar_columns := (
      SELECT string_agg(
        format('r.data->>%L ILIKE %L', candidate.scalar_key, '%' || (p_scalar_plan->>'search') || '%'),
        ' OR '
      )
      FROM (
        SELECT substring(value FROM '([a-z][a-z0-9_]*)$') AS scalar_key
        FROM jsonb_array_elements_text(COALESCE(p_scalar_plan->'searchable_columns', '[]'::jsonb))
      ) candidate
    );
    IF scalar_columns IS NOT NULL THEN where_sql := where_sql || ' AND (' || scalar_columns || ')'; END IF;
  END IF;
  FOR f IN SELECT value FROM jsonb_array_elements(p_filters) LOOP
    definition_id := (f->>'relationship_definition_id')::uuid;
    routed_side := f->>'side';
    endpoint_kind := f->>'endpoint_kind';
    endpoint_object := NULLIF(f->>'endpoint_custom_object_id', '')::uuid;
    IF routed_side NOT IN ('source', 'target') OR definition_id IS NULL THEN
      RAISE EXCEPTION 'Invalid relationship filter' USING ERRCODE = '22023';
    END IF;
    IF f->>'op' NOT IN ('any_of', 'none_of', 'is_empty', 'is_not_empty') THEN
      RAISE EXCEPTION 'Invalid relationship filter operator' USING ERRCODE = '22023';
    END IF;
    IF f->>'op' IN ('any_of', 'none_of')
      AND (
        jsonb_typeof(f->'values') <> 'array'
        OR jsonb_array_length(f->'values') = 0
      )
    THEN
      RAISE EXCEPTION 'Relationship filter values must be a non-empty array'
        USING ERRCODE = '22023';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM custom_object_relationship_definition d
      WHERE d.id = definition_id AND d.tenant_id = p_tenant_id AND d.status = 'active'
        AND ((routed_side = 'source' AND d.source_kind = 'custom_object'
              AND d.source_custom_object_id = p_custom_object_id
              AND d.show_on_source IS DISTINCT FROM false
              AND d.target_kind = endpoint_kind
              AND d.target_custom_object_id IS NOT DISTINCT FROM endpoint_object)
          OR (routed_side = 'target' AND d.target_kind = 'custom_object'
              AND d.target_custom_object_id = p_custom_object_id
              AND d.show_on_target IS DISTINCT FROM false
              AND d.source_kind = endpoint_kind
              AND d.source_custom_object_id IS NOT DISTINCT FROM endpoint_object))
    ) THEN
      RAISE EXCEPTION 'Relationship list input is not an active tenant endpoint'
        USING ERRCODE = '22023';
    END IF;
    IF endpoint_kind = 'custom_object' AND NOT EXISTS (
      SELECT 1
      FROM custom_object_definition endpoint_definition
      WHERE endpoint_definition.id = endpoint_object
        AND endpoint_definition.tenant_id = p_tenant_id
        AND endpoint_definition.status = 'active'
    ) THEN
      RAISE EXCEPTION 'Relationship list endpoint is not an active tenant object'
        USING ERRCODE = '22023';
    END IF;
    routed_column := CASE WHEN routed_side = 'source' THEN 'source_record_id' ELSE 'target_record_id' END;
    opposite_column := CASE WHEN routed_side = 'source' THEN 'target_record_id' ELSE 'source_record_id' END;
    value_ids := ARRAY(SELECT jsonb_array_elements_text(COALESCE(f->'values', '[]'::jsonb))::uuid);
    -- Every endpoint join revalidates tenant ownership. Custom-object endpoints
    -- additionally exclude archived records and enforce the endpoint object.
    clause := format(
      'EXISTS (SELECT 1 FROM custom_object_relationship e %s WHERE e.tenant_id = $1 AND e.relationship_definition_id = %L::uuid AND e.archived_at IS NULL AND e.%I = r.id %s)',
      CASE endpoint_kind
        WHEN 'custom_object' THEN format(
          'JOIN custom_object_record ep ON ep.id = e.%I AND ep.tenant_id = $1 AND ep.archived_at IS NULL AND ep.custom_object_id = %L::uuid',
          opposite_column,
          endpoint_object
        )
        WHEN 'member' THEN format(
          'JOIN member ep ON ep.id = e.%I AND ep.tenant_id = $1',
          opposite_column
        )
        WHEN 'organization' THEN format(
          'JOIN organization ep ON ep.id = e.%I AND ep.tenant_id = $1',
          opposite_column
        )
        WHEN 'organization_group' THEN format(
          'JOIN organization_group ep ON ep.id = e.%I AND ep.tenant_id = $1',
          opposite_column
        )
        ELSE ''
      END,
      definition_id, routed_column,
      CASE f->>'op'
        WHEN 'any_of' THEN format('AND e.%I = ANY(%L::uuid[])', opposite_column, value_ids)
        WHEN 'none_of' THEN format('AND e.%I = ANY(%L::uuid[])', opposite_column, value_ids)
        ELSE ''
      END
    );
    IF f->>'op' = 'none_of' OR f->>'op' = 'is_empty' THEN clause := 'NOT ' || clause; END IF;
    IF f->>'op' = 'is_not_empty' THEN NULL; END IF;
    where_sql := where_sql || ' AND ' || clause;
  END LOOP;
  IF p_sort IS NOT NULL THEN
    definition_id := (p_sort->>'relationship_definition_id')::uuid;
    routed_side := p_sort->>'side';
    endpoint_kind := p_sort->>'endpoint_kind';
    endpoint_object := NULLIF(p_sort->>'endpoint_custom_object_id', '')::uuid;
    IF routed_side NOT IN ('source', 'target')
      OR definition_id IS NULL
      OR endpoint_kind <> 'custom_object'
      OR NOT EXISTS (
        SELECT 1
        FROM custom_object_relationship_definition d
        JOIN custom_object_definition endpoint_definition
          ON endpoint_definition.id = endpoint_object
          AND endpoint_definition.tenant_id = p_tenant_id
          AND endpoint_definition.status = 'active'
        WHERE d.id = definition_id
          AND d.tenant_id = p_tenant_id
          AND d.status = 'active'
          AND (
            (routed_side = 'source'
              AND d.source_kind = 'custom_object'
              AND d.source_custom_object_id = p_custom_object_id
              AND d.show_on_source IS DISTINCT FROM false
              AND d.target_kind = 'custom_object'
              AND d.target_custom_object_id = endpoint_object)
            OR
            (routed_side = 'target'
              AND d.target_kind = 'custom_object'
              AND d.target_custom_object_id = p_custom_object_id
              AND d.show_on_target IS DISTINCT FROM false
              AND d.source_kind = 'custom_object'
              AND d.source_custom_object_id = endpoint_object)
          )
      )
    THEN
      RAISE EXCEPTION 'Invalid relationship list sort' USING ERRCODE = '22023';
    END IF;
    opposite_column := CASE WHEN routed_side = 'source' THEN 'target_record_id' ELSE 'source_record_id' END;
    routed_column := CASE WHEN routed_side = 'source' THEN 'source_record_id' ELSE 'target_record_id' END;
    display_key := NULLIF(p_sort->>'display_key', '');
    IF p_sort->>'mode' NOT IN ('label', 'count') THEN
      RAISE EXCEPTION 'Invalid relationship list sort mode' USING ERRCODE = '22023';
    END IF;
    IF p_sort->>'mode' = 'label' AND (
      display_key IS NULL
      OR NOT EXISTS (
        SELECT 1
        FROM custom_object_definition od
        JOIN preference_field pf
          ON pf.id = od.primary_display_field_id
          AND pf.tenant_id = p_tenant_id
          AND pf.custom_object_id = od.id
          AND pf.entity_scope = 'custom_object'
          AND pf.is_active = true
        WHERE od.id = endpoint_object
          AND od.tenant_id = p_tenant_id
          AND od.status = 'active'
          AND pf.name = display_key
      )
    ) THEN
      RAISE EXCEPTION 'Invalid relationship display sort field' USING ERRCODE = '22023';
    END IF;
    sort_expression := CASE WHEN p_sort->>'mode' = 'count'
      THEN format('to_jsonb((SELECT count(*) FROM custom_object_relationship e JOIN custom_object_record ep ON ep.id=e.%I AND ep.tenant_id=$1 AND ep.custom_object_id=%L::uuid AND ep.archived_at IS NULL WHERE e.tenant_id=$1 AND e.relationship_definition_id=%L::uuid AND e.archived_at IS NULL AND e.%I = r.id))', opposite_column, endpoint_object, definition_id, routed_column)
      ELSE format('to_jsonb((SELECT min(ep.data->>%L) FROM custom_object_relationship e JOIN custom_object_record ep ON ep.id=e.%I AND ep.tenant_id=$1 AND ep.custom_object_id=%L::uuid AND ep.archived_at IS NULL WHERE e.tenant_id=$1 AND e.relationship_definition_id=%L::uuid AND e.archived_at IS NULL AND e.%I=r.id))', display_key, opposite_column, endpoint_object, definition_id, routed_column)
    END;
    order_sql := 'sort_value' || CASE WHEN COALESCE((p_sort->>'ascending')::boolean, true) THEN ' ASC' ELSE ' DESC' END
      || ' NULLS LAST, id ' || CASE WHEN COALESCE((p_sort->>'ascending')::boolean, true) THEN 'ASC' ELSE 'DESC' END;
  ELSIF p_scalar_plan->>'sort_column' IS NOT NULL THEN
    IF p_scalar_plan->>'sort_column' IN ('created_at', 'updated_at') THEN
      sort_expression := 'to_jsonb(r.' || (p_scalar_plan->>'sort_column') || ')';
    ELSE
      scalar_key := substring(p_scalar_plan->>'sort_column' FROM '([a-z][a-z0-9_]*)$');
      IF scalar_key IS NULL OR NOT EXISTS (
        SELECT 1
        FROM preference_field pf
        WHERE pf.tenant_id = p_tenant_id
          AND pf.custom_object_id = p_custom_object_id
          AND pf.entity_scope = 'custom_object'
          AND pf.is_active = true
          AND pf.name = scalar_key
      ) THEN
        RAISE EXCEPTION 'Invalid scalar list sort' USING ERRCODE = '22023';
      END IF;
      sort_expression := format('r.data->%L', scalar_key);
    END IF;
    order_sql := 'sort_value' || CASE WHEN COALESCE((p_scalar_plan->>'ascending')::boolean, true) THEN ' ASC' ELSE ' DESC' END || ' NULLS LAST, id ' || CASE WHEN COALESCE((p_scalar_plan->>'ascending')::boolean, true) THEN 'ASC' ELSE 'DESC' END;
  END IF;
  RETURN QUERY EXECUTE format(
    'WITH matched AS (
       SELECT r.id, (%s) AS sort_value
       FROM custom_object_record r
       WHERE r.tenant_id=$1 AND r.custom_object_id=$2 %s
         AND ($3 OR r.archived_at IS NULL)
     ),
     counted AS (
       SELECT id, sort_value, count(*) over() AS total_count
       FROM matched
     ),
     ranked AS (
       SELECT id, total_count, row_number() over(ORDER BY %s) AS page_rank
       FROM counted
     ),
     page_rows AS (
       SELECT id, total_count, page_rank
       FROM ranked
       WHERE page_rank > $4 AND page_rank <= ($4 + $5)
     )
     SELECT output.record_id, output.total_count
     FROM (
       SELECT page_rows.id AS record_id, page_rows.total_count, page_rows.page_rank
       FROM page_rows
       UNION ALL
       SELECT NULL::uuid, count(*)::bigint, 9223372036854775807::bigint
       FROM matched
       HAVING NOT EXISTS (SELECT 1 FROM page_rows)
     ) output
     ORDER BY output.page_rank',
    COALESCE(sort_expression, 'to_jsonb(r.id::text)'), where_sql, order_sql
  ) USING p_tenant_id, p_custom_object_id, p_include_archived, p_offset, p_limit;
END $$;

REVOKE ALL ON FUNCTION public.custom_object_record_relationship_list(uuid,uuid,boolean,jsonb,jsonb,jsonb,integer,integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.custom_object_record_relationship_list(uuid,uuid,boolean,jsonb,jsonb,jsonb,integer,integer) TO service_role;

-- Returns only a bounded label sample for each relationship/list-row pair,
-- while retaining the exact eligible relationship count. This prevents a list
-- page with high-cardinality records from loading every attached edge.
CREATE OR REPLACE FUNCTION public.custom_object_record_relationship_projection(
  p_tenant_id uuid,
  p_custom_object_id uuid,
  p_items jsonb,
  p_record_ids uuid[],
  p_label_limit integer DEFAULT 3
)
RETURNS TABLE(
  list_field_id text,
  routed_record_id uuid,
  opposite_record_id uuid,
  total_count bigint
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  item jsonb;
  definition_id uuid;
  routed_side text;
  endpoint_kind text;
  endpoint_object uuid;
  display_key text;
BEGIN
  IF p_items IS NULL OR jsonb_typeof(p_items) <> 'array'
    OR jsonb_array_length(p_items) > 100
    OR p_record_ids IS NULL
    OR cardinality(p_record_ids) > 1000
    OR p_label_limit < 1 OR p_label_limit > 10
  THEN
    RAISE EXCEPTION 'Invalid relationship projection input' USING ERRCODE = '22023';
  END IF;

  FOR item IN SELECT value FROM jsonb_array_elements(p_items) LOOP
    definition_id := (item->>'relationship_definition_id')::uuid;
    routed_side := item->>'side';
    endpoint_kind := item->>'endpoint_kind';
    endpoint_object := NULLIF(item->>'endpoint_custom_object_id', '')::uuid;
    display_key := NULLIF(item->>'display_key', '');
    IF routed_side NOT IN ('source', 'target')
      OR definition_id IS NULL
      OR item->>'list_field_id' <> (
        'relationship:' || definition_id::text || ':' || routed_side
      )
      OR NOT EXISTS (
        SELECT 1
        FROM custom_object_relationship_definition d
        WHERE d.id = definition_id
          AND d.tenant_id = p_tenant_id
          AND d.status = 'active'
          AND (
            (routed_side = 'source'
              AND d.source_kind = 'custom_object'
              AND d.source_custom_object_id = p_custom_object_id
              AND d.show_on_source IS DISTINCT FROM false
              AND d.target_kind = endpoint_kind
              AND d.target_custom_object_id IS NOT DISTINCT FROM endpoint_object)
            OR
            (routed_side = 'target'
              AND d.target_kind = 'custom_object'
              AND d.target_custom_object_id = p_custom_object_id
              AND d.show_on_target IS DISTINCT FROM false
              AND d.source_kind = endpoint_kind
              AND d.source_custom_object_id IS NOT DISTINCT FROM endpoint_object)
          )
      )
    THEN
      RAISE EXCEPTION 'Invalid relationship projection item' USING ERRCODE = '22023';
    END IF;

    IF endpoint_kind = 'custom_object' AND NOT EXISTS (
      SELECT 1
      FROM custom_object_definition od
      JOIN preference_field pf
        ON pf.id = od.primary_display_field_id
        AND pf.tenant_id = p_tenant_id
        AND pf.custom_object_id = od.id
        AND pf.entity_scope = 'custom_object'
        AND pf.is_active = true
      WHERE od.id = endpoint_object
        AND od.tenant_id = p_tenant_id
        AND od.status = 'active'
        AND pf.name = display_key
    ) THEN
      RAISE EXCEPTION 'Invalid relationship projection display field'
        USING ERRCODE = '22023';
    END IF;
  END LOOP;

  RETURN QUERY
  WITH items AS (
    SELECT
      value->>'list_field_id' AS item_id,
      (value->>'relationship_definition_id')::uuid AS relationship_id,
      value->>'side' AS side,
      value->>'endpoint_kind' AS endpoint_kind,
      NULLIF(value->>'endpoint_custom_object_id', '')::uuid AS endpoint_object_id,
      NULLIF(value->>'display_key', '') AS display_key
    FROM jsonb_array_elements(p_items)
  ),
  matched AS (
    SELECT
      i.item_id,
      CASE WHEN i.side = 'source' THEN e.source_record_id ELSE e.target_record_id END AS routed_id,
      CASE WHEN i.side = 'source' THEN e.target_record_id ELSE e.source_record_id END AS opposite_id,
      CASE i.endpoint_kind
        WHEN 'custom_object' THEN cr.data->>i.display_key
        WHEN 'member' THEN COALESCE(
          NULLIF(trim(concat_ws(' ', m.first_name, m.last_name)), ''),
          m.email,
          m.id::text
        )
        WHEN 'organization' THEN COALESCE(o.name, o.id::text)
        WHEN 'organization_group' THEN COALESCE(og.name, og.id::text)
      END AS endpoint_label
    FROM items i
    JOIN custom_object_relationship e
      ON e.tenant_id = p_tenant_id
      AND e.relationship_definition_id = i.relationship_id
      AND e.archived_at IS NULL
    LEFT JOIN custom_object_record cr
      ON i.endpoint_kind = 'custom_object'
      AND cr.id = CASE WHEN i.side = 'source' THEN e.target_record_id ELSE e.source_record_id END
      AND cr.tenant_id = p_tenant_id
      AND cr.custom_object_id = i.endpoint_object_id
      AND cr.archived_at IS NULL
    LEFT JOIN member m
      ON i.endpoint_kind = 'member'
      AND m.id = CASE WHEN i.side = 'source' THEN e.target_record_id ELSE e.source_record_id END
      AND m.tenant_id = p_tenant_id
    LEFT JOIN organization o
      ON i.endpoint_kind = 'organization'
      AND o.id = CASE WHEN i.side = 'source' THEN e.target_record_id ELSE e.source_record_id END
      AND o.tenant_id = p_tenant_id
    LEFT JOIN organization_group og
      ON i.endpoint_kind = 'organization_group'
      AND og.id = CASE WHEN i.side = 'source' THEN e.target_record_id ELSE e.source_record_id END
      AND og.tenant_id = p_tenant_id
    WHERE (
      CASE WHEN i.side = 'source' THEN e.source_record_id ELSE e.target_record_id END
    ) = ANY(p_record_ids)
      AND (
        (i.endpoint_kind = 'custom_object' AND cr.id IS NOT NULL)
        OR (i.endpoint_kind = 'member' AND m.id IS NOT NULL)
        OR (i.endpoint_kind = 'organization' AND o.id IS NOT NULL)
        OR (i.endpoint_kind = 'organization_group' AND og.id IS NOT NULL)
      )
  ),
  ranked AS (
    SELECT
      matched.*,
      count(*) OVER (
        PARTITION BY matched.item_id, matched.routed_id
      ) AS matched_count,
      row_number() OVER (
        PARTITION BY matched.item_id, matched.routed_id
        ORDER BY matched.endpoint_label ASC NULLS LAST, matched.opposite_id ASC
      ) AS label_rank
    FROM matched
  )
  SELECT
    ranked.item_id,
    ranked.routed_id,
    ranked.opposite_id,
    ranked.matched_count
  FROM ranked
  WHERE ranked.label_rank <= p_label_limit
  ORDER BY ranked.item_id, ranked.routed_id, ranked.label_rank;
END $$;

REVOKE ALL ON FUNCTION public.custom_object_record_relationship_projection(uuid,uuid,jsonb,uuid[],integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.custom_object_record_relationship_projection(uuid,uuid,jsonb,uuid[],integer) TO service_role;

NOTIFY pgrst, 'reload schema';