-- Additive V2 predicates. No legacy function or saved report is changed.
BEGIN;

CREATE OR REPLACE FUNCTION public.custom_object_report_filter_value(
  actual jsonb, expected jsonb, field_type text, operator text
) RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path = public AS $$
DECLARE
  empty_value boolean := actual IS NULL OR actual = 'null'::jsonb OR actual = '""'::jsonb;
  a numeric;
  b numeric;
BEGIN
  IF operator = 'is_empty' THEN RETURN empty_value; END IF;
  IF operator = 'is_not_empty' THEN RETURN NOT empty_value; END IF;
  IF empty_value THEN RETURN false; END IF;
  IF field_type IN ('number', 'decimal') THEN
    IF jsonb_typeof(actual) <> 'number' THEN RETURN false; END IF;
    a := (actual #>> '{}')::numeric;
    b := (expected #>> '{}')::numeric;
    RETURN CASE operator WHEN 'equals' THEN a = b WHEN 'gt' THEN a > b
      WHEN 'gte' THEN a >= b WHEN 'lt' THEN a < b WHEN 'lte' THEN a <= b ELSE false END;
  ELSIF field_type = 'boolean' THEN
    RETURN jsonb_typeof(actual) = 'boolean' AND actual = expected;
  ELSE
    IF jsonb_typeof(actual) <> 'string' THEN RETURN false; END IF;
    IF operator = 'contains' THEN
      RETURN strpos(lower(actual #>> '{}'), lower(expected #>> '{}')) > 0;
    END IF;
    RETURN actual = expected;
  END IF;
END;
$$;

-- Compile only validated schema identifiers; all user values are quoted literals.
-- Called once per page before the row query, including on zero-row reports.
CREATE OR REPLACE FUNCTION public.custom_object_report_filter_predicate(
  p_tenant_id uuid, p_kind text, p_object_id uuid, p_record_expression text, p_filters jsonb
) RETURNS text LANGUAGE plpgsql STABLE SET search_path = public AS $$
DECLARE
  f jsonb; h jsonb; c jsonb; metadata jsonb; definition jsonb;
  joins text; predicates text; result text := ''; actual text;
  current_kind text; current_object uuid; endpoint_table text;
  previous_record text; side text; to_side text; key_name text; type_name text;
  n integer; last_definition uuid; last_side text;
  seen_definitions uuid[]; seen_endpoints text[];
BEGIN
  IF p_filters IS NULL OR jsonb_typeof(p_filters) <> 'array' THEN
    RAISE EXCEPTION 'Report filters must be an array' USING ERRCODE = '22023';
  END IF;
  IF jsonb_array_length(p_filters) > 10 OR p_record_expression !~ '^(r\.id|h[1-6]\.record_id)$' THEN
    RAISE EXCEPTION 'Invalid report filter input' USING ERRCODE = '22023';
  END IF;
  FOR f IN SELECT value FROM jsonb_array_elements(p_filters) LOOP
    IF jsonb_typeof(f) <> 'object' OR COALESCE(f->>'mode','') NOT IN ('any','none')
      OR jsonb_typeof(f->'path') IS DISTINCT FROM 'array'
      OR jsonb_typeof(f->'conditions') IS DISTINCT FROM 'array' THEN
      RAISE EXCEPTION 'Malformed report filter' USING ERRCODE = '22023';
    END IF;
    IF jsonb_array_length(f->'path') NOT BETWEEN 1 AND 6 OR jsonb_array_length(f->'conditions') > 10 THEN
      RAISE EXCEPTION 'Report filter exceeds traversal or condition limits' USING ERRCODE = '22023';
    END IF;
    -- Reuse authoritative tenant/active/path endpoint validation, independent of data.
    PERFORM public.custom_object_report_distinct_count(p_tenant_id, p_kind, p_object_id,
      '00000000-0000-0000-0000-000000000000'::uuid, f->'path');
    joins := ''; predicates := ''; n := 0;
    previous_record := p_record_expression;
    current_kind := p_kind; current_object := p_object_id;
    seen_definitions := ARRAY[]::uuid[];
    seen_endpoints := ARRAY[p_kind || ':' || COALESCE(p_object_id::text,'')];
    FOR h IN SELECT value FROM jsonb_array_elements(f->'path') LOOP
      n := n + 1; side := h->>'from_side';
      to_side := CASE side WHEN 'source' THEN 'target' ELSE 'source' END;
      last_definition := (h->>'relationship_definition_id')::uuid; last_side := side;
      SELECT to_jsonb(d) INTO definition FROM public.custom_object_relationship_definition d
        WHERE d.tenant_id = p_tenant_id AND d.id = last_definition;
      IF definition->('show_on_' || side) = 'false'::jsonb THEN
        RAISE EXCEPTION 'Report filter relationship is hidden' USING ERRCODE = '22023';
      END IF;
      current_kind := h->>'endpoint_kind';
      current_object := NULLIF(h->>'endpoint_custom_object_id','')::uuid;
      IF last_definition = ANY(seen_definitions)
        OR current_kind || ':' || COALESCE(current_object::text,'') = ANY(seen_endpoints) THEN
        RAISE EXCEPTION 'Report filter path is cyclic' USING ERRCODE = '22023';
      END IF;
      seen_definitions := array_append(seen_definitions,last_definition);
      seen_endpoints := array_append(seen_endpoints,current_kind || ':' || COALESCE(current_object::text,''));
      endpoint_table := CASE current_kind WHEN 'custom_object' THEN 'custom_object_record'
        WHEN 'member' THEN 'member' WHEN 'organization' THEN 'organization'
        WHEN 'organization_group' THEN 'organization_group' END;
      joins := joins || format(
        '%s public.custom_object_relationship e%s ON e%s.tenant_id = %L::uuid
         AND e%s.relationship_definition_id = %L::uuid AND e%s.archived_at IS NULL
         AND e%s.%I = %s
         JOIN public.%I n%s ON n%s.id = e%s.%I AND n%s.tenant_id = %L::uuid %s',
        CASE WHEN n = 1 THEN 'FROM (SELECT 1) seed JOIN' ELSE ' JOIN' END,
        n,n,p_tenant_id,n,last_definition,n,n,side || '_record_id',previous_record,
        endpoint_table,n,n,n,to_side || '_record_id',n,p_tenant_id,
        CASE WHEN current_kind = 'custom_object' THEN format(
          'AND n%s.custom_object_id = %L::uuid AND n%s.archived_at IS NULL', n,current_object,n)
          WHEN current_kind = 'member' THEN format(
            'AND COALESCE(n%s.email, '''') !~* ''^deleted_.+@deleted[.]local$''',n)
          ELSE '' END);
      previous_record := format('n%s.id',n);
    END LOOP;
    FOR c IN SELECT value FROM jsonb_array_elements(f->'conditions') LOOP
      metadata := NULL; key_name := NULL; type_name := NULL;
      IF c->>'kind' = 'relationship_field' THEN
        SELECT value INTO metadata FROM jsonb_array_elements(COALESCE(
          definition->'configuration'->'relationship_fields',
          definition->'configuration'->'relationshipFields', '[]'::jsonb))
          WHERE COALESCE(value->>'id',value->>'field_id') = c->>'relationship_field_id';
        key_name := COALESCE(metadata->>'key',metadata->>'name');
        type_name := COALESCE(metadata->>'type',metadata->>'field_type');
        IF COALESCE(metadata->('display_on_' || last_side),metadata->('show_on_' || last_side),
          metadata->'display'->last_side, metadata->'display') = 'false'::jsonb THEN
          RAISE EXCEPTION 'Report filter relationship field is hidden' USING ERRCODE = '22023';
        END IF;
        actual := format('e%s.field_values->%L',n,key_name);
      ELSIF c->>'kind' = 'field' AND current_kind = 'custom_object' THEN
        SELECT to_jsonb(p) INTO metadata FROM public.preference_field p
          WHERE p.tenant_id = p_tenant_id AND p.custom_object_id = current_object
            AND p.id::text = c->>'field_id' AND p.is_active IS DISTINCT FROM false
            AND (to_jsonb(p)->>'archived_at') IS NULL;
        key_name := metadata->>'name'; type_name := metadata->>'field_type';
        actual := format('n%s.data->%L',n,key_name);
      ELSIF c->>'kind' = 'field' AND (
        (current_kind = 'member' AND c->>'field' IN ('first_name','last_name','full_name','email','organization_id'))
        OR (current_kind IN ('organization','organization_group') AND c->>'field' IN ('name','email'))
      ) THEN
        key_name := c->>'field'; type_name := 'text';
        actual := CASE WHEN key_name = 'full_name' THEN
          format('to_jsonb(trim(concat_ws('' '',n%s.first_name,n%s.last_name)))',n,n)
          ELSE format('to_jsonb(n%s.%I)',n,key_name) END;
      END IF;
      IF key_name IS NULL OR type_name IS NULL
        OR key_name IS DISTINCT FROM c->>'key' OR type_name IS DISTINCT FROM c->>'type'
        OR type_name NOT IN ('text','textarea','email','url','boolean','number','decimal')
        OR COALESCE(c->>'op','') NOT IN ('equals','contains','gt','gte','lt','lte','is_empty','is_not_empty')
        OR (c->>'op' = 'contains' AND type_name NOT IN ('text','textarea','email','url'))
        OR (c->>'op' IN ('gt','gte','lt','lte') AND type_name NOT IN ('number','decimal'))
      THEN RAISE EXCEPTION 'Report filter field or operator is unavailable; repair the filter' USING ERRCODE = '22023';
      END IF;
      IF c->>'op' NOT IN ('is_empty','is_not_empty') AND (
        jsonb_typeof(c->'value') IS DISTINCT FROM CASE
          WHEN type_name = 'boolean' THEN 'boolean'
          WHEN type_name IN ('number','decimal') THEN 'number' ELSE 'string' END
      ) THEN RAISE EXCEPTION 'Report filter value has wrong type' USING ERRCODE = '22023'; END IF;
      IF c->>'op' NOT IN ('is_empty','is_not_empty') AND type_name IN ('number','decimal') THEN
        -- Match the service's finite IEEE-number contract, not arbitrary JSON numerics.
        PERFORM (c->>'value')::double precision;
      END IF;
      predicates := predicates || format(' AND public.custom_object_report_filter_value(%s,%L::jsonb,%L,%L)',
        actual,c->'value',type_name,c->>'op');
    END LOOP;
    result := result || format(' AND %s EXISTS (SELECT 1 %s WHERE true %s)',
      CASE f->>'mode' WHEN 'none' THEN 'NOT' ELSE '' END,joins,predicates);
  END LOOP;
  RETURN result;
END;
$$;

-- Preserve the proven native prefix-seek, nullable occurrence and page ordering
-- implementation verbatim. Fail migration if its insertion anchor has changed.
DO $migration$
DECLARE body text;
BEGIN
  SELECT prosrc INTO STRICT body FROM pg_proc
    WHERE oid = 'public.custom_object_report_summary_page(uuid,text,uuid,jsonb,boolean,integer,integer,text,boolean)'::regprocedure;
  IF strpos(body, '  IF COALESCE(p_include_total, false) THEN') = 0 THEN
    RAISE EXCEPTION 'Report summary prerequisite changed; review filter migration';
  END IF;
  body := replace(body, '  IF COALESCE(p_include_total, false) THEN',
    '  v_query := v_query || public.custom_object_report_filter_predicate(
       p_tenant_id, v_current_kind, v_current_object_id, v_terminal_record, p_filters);
  IF COALESCE(p_include_total, false) THEN');
  -- Only this new filtered RPC adopts deletion eligibility; legacy reports stay untouched.
  body := replace(body, ') ELSE '''' END,', $replacement$)
      WHEN v_endpoint_kind = 'member' THEN
        'AND COALESCE(endpoint.email, '''') !~* ''^deleted_.+@deleted[.]local$'''
      ELSE '' END,$replacement$);
  body := replace(body, E'\n  v_query := format(', $replacement$
  IF p_start_kind = 'member' THEN
    v_root_predicate := v_root_predicate ||
      ' AND COALESCE(r.email, '''') !~* ''^deleted_.+@deleted[.]local$''';
  END IF;
  v_query := format($replacement$);
  EXECUTE 'CREATE OR REPLACE FUNCTION public.custom_object_report_filtered_summary_page(
    p_tenant_id uuid, p_start_kind text, p_start_custom_object_id uuid,
    p_grain_path jsonb, p_include_empty boolean, p_offset integer, p_limit integer,
    p_after_cursor text, p_include_total boolean, p_filters jsonb
  ) RETURNS jsonb LANGUAGE plpgsql STABLE SET search_path = public AS ' || quote_literal(body);
END;
$migration$;

REVOKE ALL ON FUNCTION public.custom_object_report_filter_value(jsonb,jsonb,text,text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.custom_object_report_filter_predicate(uuid,text,uuid,text,jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.custom_object_report_filtered_summary_page(uuid,text,uuid,jsonb,boolean,integer,integer,text,boolean,jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.custom_object_report_filter_value(jsonb,jsonb,text,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.custom_object_report_filter_predicate(uuid,text,uuid,text,jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.custom_object_report_filtered_summary_page(uuid,text,uuid,jsonb,boolean,integer,integer,text,boolean,jsonb) TO service_role;
NOTIFY pgrst, 'reload schema';
COMMIT;