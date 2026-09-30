-- Canvas extension for publish_member_content_repair.
--
-- This replaces the six-argument function from the preceding focused repair
-- migration.  It intentionally does not create a dependency table: Canvas
-- dependency edges are the JSON contract already enforced by
-- match_member_content_chunks (provenance.dependencies).

CREATE OR REPLACE FUNCTION public.publish_member_content_repair(
  p_tenant_id uuid,
  p_content_type text,
  p_source_id uuid,
  p_generation bigint,
  p_claim_token uuid,
  p_rows jsonb
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  source_row record;
  payload_row record;
  dependency_value jsonb;
  dependency_array jsonb;
  dependency_count integer := 0;
  locked_dependency_count integer := 0;
  child_row record;
  dep_source_id uuid;
  dep_generation bigint;
  row_count integer;
  distinct_indexes integer;
  min_index integer;
  max_index integer;
  text_bytes bigint;
  metadata_conflict boolean;
  queue_table text;
BEGIN
  -- Preserve the read-only readiness probe before temporary staging or locks.
  IF p_tenant_id IS NULL OR p_content_type IS NULL OR p_source_id IS NULL
     OR p_generation IS NULL OR p_claim_token IS NULL THEN
    RETURN false;
  END IF;
  /*
   * Parse dependency metadata before taking the parent lock.  Symbol source
   * rows are locked first, in source-id order, matching the source-change
   * invalidation order (symbol, then parent).  A malformed dependency object
   * is an error; a missing/stale registry row is a fenced no-op.
   */
  IF p_rows IS NULL OR jsonb_typeof(p_rows) <> 'array' THEN
    RAISE EXCEPTION 'p_rows must be a JSON array' USING ERRCODE = '22023';
  END IF;
  IF jsonb_array_length(p_rows) > 100 THEN
    RAISE EXCEPTION 'repair snapshot may contain at most 100 chunks'
      USING ERRCODE = '22023';
  END IF;
  IF pg_column_size(p_rows) > 10 * 1024 * 1024 THEN
    RAISE EXCEPTION 'repair snapshot JSON is too large' USING ERRCODE = '22023';
  END IF;

  DROP TABLE IF EXISTS pg_temp.member_content_repair_payload_dependencies;
  DROP TABLE IF EXISTS pg_temp.member_content_repair_dependencies;
  CREATE TEMP TABLE pg_temp.member_content_repair_payload_dependencies (
    row_number integer PRIMARY KEY,
    dependencies jsonb NOT NULL
  ) ON COMMIT DROP;
  CREATE TEMP TABLE pg_temp.member_content_repair_dependencies (
    source_id uuid PRIMARY KEY,
    generation bigint NOT NULL
  ) ON COMMIT DROP;

  FOR payload_row IN
    SELECT value, ordinality::integer AS row_number
    FROM jsonb_array_elements(p_rows) WITH ORDINALITY AS item(value, ordinality)
  LOOP
    dependency_array := payload_row.value->'provenance'->'dependencies';
    IF dependency_array IS NULL OR jsonb_typeof(dependency_array) = 'null' THEN
      IF p_content_type = 'canvas_page' THEN
        RAISE EXCEPTION
          'Canvas repair rows require provenance.dependencies array'
          USING ERRCODE = '22023';
      END IF;
      dependency_array := '[]'::jsonb;
    END IF;
    IF jsonb_typeof(dependency_array) <> 'array' THEN
      RAISE EXCEPTION
        'provenance.dependencies must be a JSON array'
        USING ERRCODE = '22023';
    END IF;
    IF jsonb_array_length(dependency_array) > 100 THEN
      RAISE EXCEPTION 'repair snapshot may contain at most 100 dependencies'
        USING ERRCODE = '22023';
    END IF;
    IF p_content_type <> 'canvas_page'
       AND jsonb_array_length(dependency_array) > 0 THEN
      RAISE EXCEPTION
        'dependency edges are supported only for canvas_page'
        USING ERRCODE = '22023';
    END IF;
    INSERT INTO pg_temp.member_content_repair_payload_dependencies(
      row_number, dependencies
    ) VALUES (payload_row.row_number, dependency_array);
  END LOOP;

  -- Dependency arrays are canonical metadata and must be identical on every
  -- chunk.  The normal metadata check below also fences every other field.
  IF EXISTS (
    SELECT 1
    FROM pg_temp.member_content_repair_payload_dependencies
    GROUP BY dependencies
    HAVING count(*) > 0
  ) AND (
    SELECT count(DISTINCT dependencies)
    FROM pg_temp.member_content_repair_payload_dependencies
  ) > 1 THEN
    RAISE EXCEPTION
      'repair snapshot contains conflicting dependency metadata'
      USING ERRCODE = '22023';
  END IF;

  SELECT dependencies
  INTO dependency_array
  FROM pg_temp.member_content_repair_payload_dependencies
  ORDER BY row_number
  LIMIT 1;

  IF dependency_array IS NOT NULL THEN
    FOR dependency_value IN
      SELECT value
      FROM jsonb_array_elements(dependency_array)
    LOOP
      IF jsonb_typeof(dependency_value) <> 'object'
         OR (
           CASE WHEN jsonb_typeof(dependency_value) = 'object' THEN (
             SELECT count(*)
             FROM jsonb_object_keys(dependency_value)
           ) ELSE 0 END
         ) <> 3
         OR NOT (dependency_value ? 'contentType')
         OR NOT (dependency_value ? 'sourceId')
         OR NOT (dependency_value ? 'generation')
         OR dependency_value ? 'content_type'
         OR dependency_value ? 'source_id' THEN
        RAISE EXCEPTION
          'Canvas dependency must use exactly contentType, sourceId, generation'
          USING ERRCODE = '22023';
      END IF;
      IF dependency_value->>'contentType' IS DISTINCT FROM 'canvas_symbol' THEN
        RAISE EXCEPTION
          'Canvas dependency contentType must be canvas_symbol'
          USING ERRCODE = '22023';
      END IF;
      IF NULLIF(dependency_value->>'sourceId', '') IS NULL
         OR NULLIF(dependency_value->>'generation', '') IS NULL THEN
        RAISE EXCEPTION
          'Canvas dependency sourceId and generation are required'
          USING ERRCODE = '22023';
      END IF;
      BEGIN
        dep_source_id := (dependency_value->>'sourceId')::uuid;
        dep_generation := (dependency_value->>'generation')::bigint;
      EXCEPTION WHEN invalid_text_representation THEN
        RAISE EXCEPTION
          'Canvas dependency sourceId/generation types are invalid'
          USING ERRCODE = '22023';
      END;
      IF dep_generation <= 0 THEN
        RAISE EXCEPTION
          'Canvas dependency generation must be positive'
          USING ERRCODE = '22023';
      END IF;
      BEGIN
        INSERT INTO pg_temp.member_content_repair_dependencies(
          source_id, generation
        ) VALUES (dep_source_id, dep_generation);
      EXCEPTION WHEN unique_violation THEN
        RAISE EXCEPTION
          'Canvas dependency sourceId is duplicated with conflicting generations'
          USING ERRCODE = '22023';
      END;
    END LOOP;
  END IF;

  SELECT count(*)::integer
  INTO dependency_count
  FROM pg_temp.member_content_repair_dependencies;

  IF dependency_count > 100 THEN
    RAISE EXCEPTION 'repair snapshot may contain at most 100 dependencies'
      USING ERRCODE = '22023';
  END IF;

  IF dependency_count > 0 THEN
    FOR child_row IN
      SELECT
        s.source_id,
        s.generation,
        s.active_generation,
        d.generation AS dependency_generation
      FROM public.member_content_source AS s
      JOIN pg_temp.member_content_repair_dependencies AS d
        ON d.source_id = s.source_id
      WHERE s.tenant_id = p_tenant_id
        AND s.content_type = 'canvas_symbol'
      ORDER BY d.source_id
      FOR UPDATE OF s
    LOOP
      locked_dependency_count := locked_dependency_count + 1;
      IF child_row.generation IS DISTINCT FROM child_row.dependency_generation
         OR child_row.active_generation IS DISTINCT FROM child_row.dependency_generation THEN
        RETURN false;
      END IF;
    END LOOP;
    -- A missing child (including a cross-tenant child) is stale, not a
    -- validation error, and therefore cannot mutate the parent or chunks.
    IF locked_dependency_count <> dependency_count THEN
      RETURN false;
    END IF;
  END IF;

  -- Parent CAS follows the stable child lock order.
  SELECT
    s.generation,
    s.claim_token,
    s.claim_started_at
  INTO source_row
  FROM public.member_content_source AS s
  WHERE s.tenant_id = p_tenant_id
    AND s.content_type = p_content_type
    AND s.source_id = p_source_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN false;
  END IF;
  IF p_generation IS NULL
     OR p_claim_token IS NULL
     OR source_row.generation IS DISTINCT FROM p_generation
     OR source_row.claim_token IS DISTINCT FROM p_claim_token THEN
    RETURN false;
  END IF;
  IF source_row.claim_started_at IS NULL
     OR source_row.claim_started_at <= (now() - interval '5 minutes')::timestamp THEN
    RETURN false;
  END IF;

  IF p_content_type NOT IN (
    'resource', 'event', 'complex_event', 'news_post', 'blog_post', 'canvas_page'
  ) THEN
    RAISE EXCEPTION
      'unsupported authored member-content type: %', p_content_type
      USING ERRCODE = '22023';
  END IF;
  IF p_generation <= 0 THEN
    RAISE EXCEPTION 'generation must be positive' USING ERRCODE = '22023';
  END IF;

  DROP TABLE IF EXISTS pg_temp.member_content_repair_rows;
  CREATE TEMP TABLE pg_temp.member_content_repair_rows
    ON COMMIT DROP
    AS SELECT * FROM public.member_content_chunk WITH NO DATA;

  INSERT INTO pg_temp.member_content_repair_rows
  SELECT *
  FROM jsonb_populate_recordset(NULL::public.member_content_chunk, p_rows);

  UPDATE pg_temp.member_content_repair_rows
  SET tenant_id = p_tenant_id,
      content_type = p_content_type,
      source_id = p_source_id,
      source_generation = p_generation,
      activation_token = p_claim_token,
      is_active = false,
      linked_events = COALESCE(linked_events, '[]'::jsonb),
      provenance = COALESCE(provenance, '{}'::jsonb)
  -- PostgREST enforces safe updates even for temporary staging tables.
  -- Null indices remain in staging and fail the count validation below.
  WHERE chunk_index IS NOT NULL;

  SELECT
    count(*)::integer,
    count(DISTINCT chunk_index)::integer,
    min(chunk_index),
    max(chunk_index),
    COALESCE(sum(octet_length(content)::bigint), 0)
  INTO row_count, distinct_indexes, min_index, max_index, text_bytes
  FROM pg_temp.member_content_repair_rows;

  IF text_bytes > 500 * 1024 THEN
    RAISE EXCEPTION 'repair snapshot text exceeds 500 KiB'
      USING ERRCODE = '22023';
  END IF;
  IF row_count > 0 THEN
    IF EXISTS (
      SELECT 1 FROM pg_temp.member_content_repair_rows
      WHERE chunk_index IS NULL OR content IS NULL OR title IS NULL
    ) THEN
      RAISE EXCEPTION
        'every nonempty repair snapshot row needs chunk_index, title, and content'
        USING ERRCODE = '22023';
    END IF;
    IF distinct_indexes <> row_count
       OR min_index <> 0
       OR max_index <> row_count - 1 THEN
      RAISE EXCEPTION
        'repair snapshot chunk indexes must be contiguous, unique, and start at zero'
        USING ERRCODE = '22023';
    END IF;
    IF EXISTS (
      SELECT 1 FROM pg_temp.member_content_repair_rows
      WHERE content_hash IS NULL
         OR btrim(content_hash) = ''
         OR embedding IS NULL
         OR btrim(embedding::text) = ''
    ) THEN
      RAISE EXCEPTION
        'every nonempty repair snapshot row needs a nonempty embedding and content_hash'
        USING ERRCODE = '22023';
    END IF;
  END IF;

  SELECT EXISTS (
    SELECT 1
    FROM pg_temp.member_content_repair_rows AS r
    CROSS JOIN LATERAL (
      SELECT * FROM pg_temp.member_content_repair_rows
      ORDER BY chunk_index NULLS LAST
      LIMIT 1
    ) AS first_row
    WHERE r.slug IS DISTINCT FROM first_row.slug
       OR r.title IS DISTINCT FROM first_row.title
       OR r.link IS DISTINCT FROM first_row.link
       OR r.status IS DISTINCT FROM first_row.status
       OR r.event_state IS DISTINCT FROM first_row.event_state
       OR r.member_group_id IS DISTINCT FROM first_row.member_group_id
       OR r.group_event_public IS DISTINCT FROM first_row.group_event_public
       OR r.allowed_role_ids IS DISTINCT FROM first_row.allowed_role_ids
       OR r.is_public IS DISTINCT FROM first_row.is_public
       OR r.published_date IS DISTINCT FROM first_row.published_date
       OR r.start_date IS DISTINCT FROM first_row.start_date
       OR r.feature_key IS DISTINCT FROM first_row.feature_key
       OR r.access_scope IS DISTINCT FROM first_row.access_scope
       OR r.linked_events IS DISTINCT FROM first_row.linked_events
       OR r.subcategories IS DISTINCT FROM first_row.subcategories
       OR r.layout_type IS DISTINCT FROM first_row.layout_type
       OR r.microsite_id IS DISTINCT FROM first_row.microsite_id
       OR r.source_updated_at IS DISTINCT FROM first_row.source_updated_at
       OR r.symbol_versions IS DISTINCT FROM first_row.symbol_versions
       OR r.provenance IS DISTINCT FROM first_row.provenance
       OR r.embedding_model IS DISTINCT FROM first_row.embedding_model
  )
  INTO metadata_conflict;

  IF metadata_conflict THEN
    RAISE EXCEPTION 'repair snapshot contains conflicting canonical metadata'
      USING ERRCODE = '22023';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_temp.member_content_repair_rows
    WHERE access_scope IS NULL OR access_scope NOT IN ('public', 'authenticated')
  ) THEN
    RAISE EXCEPTION
      'repair snapshot requires explicit access_scope public or authenticated'
      USING ERRCODE = '22023';
  END IF;
  IF p_content_type = 'canvas_page'
     AND EXISTS (
       SELECT 1 FROM pg_temp.member_content_repair_rows
       WHERE access_scope <> 'public'
          OR layout_type IS NULL
          OR layout_type NOT IN (
            'public', 'hybrid', 'public_no_chrome',
            'public_header_only', 'public_footer_only'
          )
     ) THEN
    RAISE EXCEPTION
      'Canvas repair requires a supported public layout and public access_scope'
      USING ERRCODE = '22023';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_temp.member_content_repair_rows
    WHERE provenance <> '{}'::jsonb
      AND provenance->>'kind' IS DISTINCT FROM 'authored_repair'
  ) THEN
    RAISE EXCEPTION 'repair snapshot provenance is not authored_repair-safe'
      USING ERRCODE = '22023';
  END IF;

  -- All destructive work is after validation and the rich provenance fence.
  IF EXISTS (
    SELECT 1
    FROM public.member_content_chunk AS c
    WHERE c.tenant_id = p_tenant_id
      AND c.content_type = p_content_type
      AND c.source_id = p_source_id
      AND COALESCE(c.provenance, '{}'::jsonb) <> '{}'::jsonb
      AND COALESCE(c.provenance, '{}'::jsonb)->>'kind'
        IS DISTINCT FROM 'authored_repair'
  ) THEN
    RAISE EXCEPTION
      'existing source chunks have non-authored provenance; refusing destructive repair'
      USING ERRCODE = '55000';
  END IF;

  IF row_count > 0 THEN
    INSERT INTO public.member_content_chunk (
      tenant_id, content_type, source_id, slug, title, chunk_index, content,
      link, status, event_state, member_group_id, group_event_public,
      allowed_role_ids, is_public, published_date, start_date, feature_key,
      content_hash, embedding, source_generation, activation_token, is_active,
      access_scope, linked_events, subcategories, layout_type, microsite_id,
      source_updated_at, symbol_versions, provenance, embedding_model
    )
    SELECT
      tenant_id, content_type, source_id, slug, title, chunk_index, content,
      link, status, event_state, member_group_id, group_event_public,
      allowed_role_ids, is_public, published_date, start_date, feature_key,
      content_hash, embedding, source_generation, activation_token, is_active,
      access_scope, linked_events, subcategories, layout_type, microsite_id,
      source_updated_at, symbol_versions, provenance, embedding_model
    FROM pg_temp.member_content_repair_rows
    ORDER BY chunk_index
    ON CONFLICT (
      tenant_id, content_type, source_id, chunk_index, source_generation
    ) DO UPDATE SET
      slug = EXCLUDED.slug,
      title = EXCLUDED.title,
      content = EXCLUDED.content,
      link = EXCLUDED.link,
      status = EXCLUDED.status,
      event_state = EXCLUDED.event_state,
      member_group_id = EXCLUDED.member_group_id,
      group_event_public = EXCLUDED.group_event_public,
      allowed_role_ids = EXCLUDED.allowed_role_ids,
      is_public = EXCLUDED.is_public,
      published_date = EXCLUDED.published_date,
      start_date = EXCLUDED.start_date,
      feature_key = EXCLUDED.feature_key,
      content_hash = EXCLUDED.content_hash,
      embedding = EXCLUDED.embedding,
      activation_token = EXCLUDED.activation_token,
      is_active = false,
      access_scope = EXCLUDED.access_scope,
      linked_events = EXCLUDED.linked_events,
      subcategories = EXCLUDED.subcategories,
      layout_type = EXCLUDED.layout_type,
      microsite_id = EXCLUDED.microsite_id,
      source_updated_at = EXCLUDED.source_updated_at,
      symbol_versions = EXCLUDED.symbol_versions,
      provenance = EXCLUDED.provenance,
      embedding_model = EXCLUDED.embedding_model,
      updated_at = now();
  END IF;

  DELETE FROM public.member_content_chunk AS c
  WHERE c.tenant_id = p_tenant_id
    AND c.content_type = p_content_type
    AND c.source_id = p_source_id
    AND (
      row_count = 0
      OR c.source_generation <> p_generation
      OR c.activation_token IS DISTINCT FROM p_claim_token
      OR (
        c.activation_token = p_claim_token
        AND NOT EXISTS (
          SELECT 1 FROM pg_temp.member_content_repair_rows AS r
          WHERE r.chunk_index = c.chunk_index
        )
      )
    )
    AND (
      COALESCE(c.provenance, '{}'::jsonb) = '{}'::jsonb
      OR COALESCE(c.provenance, '{}'::jsonb)->>'kind' = 'authored_repair'
    );

  UPDATE public.member_content_chunk AS c
  SET is_active = true
  WHERE c.tenant_id = p_tenant_id
    AND c.content_type = p_content_type
    AND c.source_id = p_source_id
    AND c.source_generation = p_generation
    AND c.activation_token = p_claim_token;

  UPDATE public.member_content_source AS s
  SET active_generation = p_generation,
      claim_token = NULL,
      claim_started_at = NULL
  WHERE s.tenant_id = p_tenant_id
    AND s.content_type = p_content_type
    AND s.source_id = p_source_id
    AND s.generation = p_generation
    AND s.claim_token = p_claim_token;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'source claim changed during repair publication';
  END IF;

  FOREACH queue_table IN ARRAY ARRAY[
    'member_content_reindex_job',
    'member_content_reindex_jobs',
    'member_content_reindex_queue',
    'member_content_reindex'
  ] LOOP
    IF to_regclass('public.' || quote_ident(queue_table)) IS NOT NULL
       AND EXISTS (
         SELECT 1
         FROM information_schema.columns
         WHERE table_schema = 'public'
           AND table_name = queue_table
           AND column_name IN ('tenant_id', 'content_type', 'source_id')
         GROUP BY table_schema, table_name
         HAVING count(*) = 3
       ) THEN
      EXECUTE format(
        'DELETE FROM public.%I
          WHERE tenant_id = $1 AND content_type = $2 AND source_id = $3',
        queue_table
      ) USING p_tenant_id, p_content_type, p_source_id;
      EXIT;
    END IF;
  END LOOP;

  RETURN true;
END;
$function$;

REVOKE ALL ON FUNCTION public.publish_member_content_repair(
  uuid, text, uuid, bigint, uuid, jsonb
) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.publish_member_content_repair(
  uuid, text, uuid, bigint, uuid, jsonb
) TO service_role;

NOTIFY pgrst, 'reload schema';