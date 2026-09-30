-- Member-content repair publication (destination schema repair).
--
-- This migration deliberately does not replay 20260706_member_content_chunk
-- and does not modify the existing claim, activation, invalidation, or
-- retrieval functions.  The repair writer publishes one complete, fenced
-- snapshot while holding the source row lock.

DO $migration$
DECLARE
  generation_key boolean;
  legacy_key boolean;
  reserved_name_taken boolean;
  reserved_name_valid boolean;
BEGIN
  IF to_regclass('public.member_content_chunk') IS NULL THEN
    RAISE EXCEPTION
      'member_content_chunk is required; refusing to create a repair writer';
  END IF;
  IF to_regclass('public.member_content_source') IS NULL THEN
    RAISE EXCEPTION
      'member_content_source is required; refusing to create a repair writer';
  END IF;

  /*
   * Check the catalog rather than trusting an index name.  indkey is inspected
   * in order, so an expression, a partial predicate, an INCLUDE column, an
   * invalid/concurrently-built index, or a reordered key cannot be accepted.
   */
  WITH candidates AS (
    SELECT
      i.indexrelid,
      i.indisunique,
      i.indisvalid,
      i.indisready,
      i.indimmediate,
      i.indnatts,
      i.indnkeyatts,
      i.indpred,
      i.indexprs,
      bool_and(k.attnum > 0) AS expression_free,
      array_agg(a.attname ORDER BY k.ord)
        FILTER (WHERE k.ord <= i.indnkeyatts)::text[] AS key_names
    FROM pg_index AS i
    CROSS JOIN LATERAL unnest(i.indkey::int2[]) WITH ORDINALITY
      AS k(attnum, ord)
    LEFT JOIN pg_attribute AS a
      ON a.attrelid = i.indrelid
     AND a.attnum = k.attnum
    WHERE i.indrelid = 'public.member_content_chunk'::regclass
    GROUP BY
      i.indexrelid, i.indisunique, i.indisvalid, i.indisready,
      i.indimmediate, i.indnatts, i.indnkeyatts, i.indpred, i.indexprs
  )
  SELECT EXISTS (
    SELECT 1
    FROM candidates
    WHERE indisunique
      AND indisvalid
      AND indisready
      AND indimmediate
      AND indnatts = 5
      AND indnkeyatts = 5
      AND indpred IS NULL
      AND indexprs IS NULL
      AND expression_free
      AND key_names = ARRAY[
        'tenant_id', 'content_type', 'source_id', 'chunk_index',
        'source_generation'
      ]::text[]
  )
  INTO generation_key;

  /*
   * The legacy three-key unique index must never be dropped as part of this
   * repair.  It makes generation staging impossible, so fail loudly even if
   * a generation key happens to have been created alongside it.
   */
  WITH candidates AS (
    SELECT
      i.indexrelid,
      i.indisunique,
      i.indnkeyatts,
      array_agg(a.attname ORDER BY k.ord)
        FILTER (WHERE k.ord <= i.indnkeyatts)::text[] AS key_names
    FROM pg_index AS i
    CROSS JOIN LATERAL unnest(i.indkey::int2[]) WITH ORDINALITY
      AS k(attnum, ord)
    LEFT JOIN pg_attribute AS a
      ON a.attrelid = i.indrelid
     AND a.attnum = k.attnum
    WHERE i.indrelid = 'public.member_content_chunk'::regclass
      GROUP BY i.indexrelid, i.indisunique, i.indnkeyatts
  )
  SELECT EXISTS (
    SELECT 1
    FROM candidates
    WHERE indisunique
      AND indnkeyatts = 3
      AND key_names = ARRAY[
        'content_type', 'source_id', 'chunk_index'
      ]::text[]
  )
  INTO legacy_key;

  IF legacy_key THEN
    RAISE EXCEPTION
      'legacy three-key unique index exists on member_content_chunk; refusing to drop it';
  END IF;

  SELECT EXISTS (
    SELECT 1
    FROM pg_class AS c
    JOIN pg_namespace AS n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relname = 'member_content_chunk_generation_idx'
  )
  INTO reserved_name_taken;

  IF reserved_name_taken THEN
    WITH candidates AS (
      SELECT
        i.indexrelid,
        i.indisunique,
        i.indisvalid,
        i.indisready,
        i.indimmediate,
        i.indnatts,
        i.indnkeyatts,
        i.indpred,
        i.indexprs,
        bool_and(k.attnum > 0) AS expression_free,
        array_agg(a.attname ORDER BY k.ord)::text[] AS key_names
      FROM pg_index AS i
      CROSS JOIN LATERAL unnest(i.indkey::int2[]) WITH ORDINALITY
        AS k(attnum, ord)
      LEFT JOIN pg_attribute AS a
        ON a.attrelid = i.indrelid
       AND a.attnum = k.attnum
      JOIN pg_class AS c ON c.oid = i.indexrelid
      JOIN pg_namespace AS n ON n.oid = c.relnamespace
      WHERE i.indrelid = 'public.member_content_chunk'::regclass
        AND n.nspname = 'public'
        AND c.relname = 'member_content_chunk_generation_idx'
      GROUP BY
        i.indexrelid, i.indisunique, i.indisvalid, i.indisready,
        i.indimmediate, i.indnatts, i.indnkeyatts, i.indpred, i.indexprs
    )
    SELECT EXISTS (
      SELECT 1
      FROM candidates
      WHERE indisunique
        AND indisvalid
        AND indisready
        AND indimmediate
        AND indnatts = 5
        AND indnkeyatts = 5
        AND indpred IS NULL
        AND indexprs IS NULL
        AND expression_free
        AND key_names = ARRAY[
          'tenant_id', 'content_type', 'source_id', 'chunk_index',
          'source_generation'
        ]::text[]
    )
    INTO reserved_name_valid;

    IF NOT reserved_name_valid THEN
      RAISE EXCEPTION
        'member_content_chunk_generation_idx exists but is not a valid five-key generation unique index';
    END IF;
  END IF;

  IF NOT generation_key THEN

    IF NOT reserved_name_taken THEN
      EXECUTE $ddl$
        CREATE UNIQUE INDEX member_content_chunk_generation_idx
          ON public.member_content_chunk
            (tenant_id, content_type, source_id, chunk_index, source_generation)
      $ddl$;
    END IF;
  END IF;
END;
$migration$;

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
/*
 * p_rows is a JSON array of flat chunk objects.  Each nonempty snapshot row
 * must contain chunk_index (0..N-1), content, content_hash, embedding (a
 * textual vector such as "[0.1,0.2]"), and the canonical source metadata:
 * slug, title, link, status, event_state, member_group_id,
 * group_event_public, allowed_role_ids, is_public, published_date,
 * start_date, feature_key, access_scope (explicit "authenticated" or
 * validated "public"), linked_events, subcategories,
 * layout_type, microsite_id, source_updated_at, symbol_versions,
 * provenance, and embedding_model.  Optional metadata may be JSON null.
 * tenant_id, content_type, source_id, source_generation, activation_token,
 * and is_active in the payload are ignored and overwritten from the RPC
 * arguments/locked claim.  An empty array publishes a removed source.
 */
DECLARE
  source_row record;
  row_count integer;
  distinct_indexes integer;
  min_index integer;
  max_index integer;
  text_bytes bigint;
  metadata_conflict boolean;
  queue_table text;
BEGIN
  /*
   * Lock and fence before parsing the worker payload.  In particular, a
   * stale/expired worker returns false without creating a staging relation,
   * deleting rows, or touching the source/queue.
   */
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

  -- Claims are five-minute leases; a worker that did not renew/reclaim it
  -- cannot publish merely because nobody has claimed a replacement yet.
  IF source_row.claim_started_at IS NULL
     OR source_row.claim_started_at <= (now() - interval '5 minutes')::timestamp THEN
    RETURN false;
  END IF;

  IF p_content_type NOT IN (
    'resource', 'event', 'complex_event', 'news_post', 'blog_post'
  ) THEN
    RAISE EXCEPTION
      'unsupported authored member-content type: %', p_content_type
      USING ERRCODE = '22023';
  END IF;
  IF p_generation <= 0 THEN
    RAISE EXCEPTION 'generation must be positive' USING ERRCODE = '22023';
  END IF;
  IF p_rows IS NULL OR jsonb_typeof(p_rows) <> 'array' THEN
    RAISE EXCEPTION 'p_rows must be a JSON array' USING ERRCODE = '22023';
  END IF;
  IF jsonb_array_length(p_rows) > 100 THEN
    RAISE EXCEPTION 'repair snapshot may contain at most 100 chunks'
      USING ERRCODE = '22023';
  END IF;
  -- Bound the statement itself as well as the decoded text below.
  IF pg_column_size(p_rows) > 10 * 1024 * 1024 THEN
    RAISE EXCEPTION 'repair snapshot JSON is too large' USING ERRCODE = '22023';
  END IF;

  /*
   * Populate through the deployed table composite type.  This makes the
   * embedding input the documented JSON vector string (and also keeps this
   * function usable by a portable fixture whose embedding column is text).
   * Scope, generation, activation token, and active state are overwritten
   * immediately below; no caller-supplied values for those fields are used.
   */
  DROP TABLE IF EXISTS pg_temp.member_content_repair_rows;
  CREATE TEMP TABLE pg_temp.member_content_repair_rows
    ON COMMIT DROP
    AS SELECT * FROM public.member_content_chunk WITH NO DATA;

  INSERT INTO pg_temp.member_content_repair_rows
  SELECT *
  FROM jsonb_populate_recordset(
    NULL::public.member_content_chunk,
    p_rows
  );

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
      SELECT 1
      FROM pg_temp.member_content_repair_rows
      WHERE chunk_index IS NULL
         OR content IS NULL
         OR title IS NULL
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
      SELECT 1
      FROM pg_temp.member_content_repair_rows
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

  -- All chunks are one canonical source snapshot; only chunk text/hash/vector
  -- are allowed to differ between indexes.
  SELECT EXISTS (
    SELECT 1
    FROM pg_temp.member_content_repair_rows AS r
    CROSS JOIN LATERAL (
      SELECT *
      FROM pg_temp.member_content_repair_rows
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
    SELECT 1
    FROM pg_temp.member_content_repair_rows
    WHERE access_scope IS NULL
       OR access_scope NOT IN ('public', 'authenticated')
  ) THEN
    RAISE EXCEPTION
      'repair snapshot requires explicit access_scope public or authenticated'
      USING ERRCODE = '22023';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM pg_temp.member_content_repair_rows
    WHERE provenance <> '{}'::jsonb
      AND provenance->>'kind' IS DISTINCT FROM 'authored_repair'
  ) THEN
    RAISE EXCEPTION 'repair snapshot provenance is not authored_repair-safe'
      USING ERRCODE = '22023';
  END IF;

  /*
   * Rich rows are intentionally a hard fence.  Empty provenance and the
   * authored-repair marker are the only rows this operation may replace.
   */
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
    /*
     * Upsert against the generation-aware five-key unique index.  Existing
     * rows for the same generation/index retain their id and created_at; only
     * canonical mutable columns are replaced.  Payload identity fields were
     * overwritten above, so no caller JSON can move a row to another scope.
     */
    INSERT INTO public.member_content_chunk (
      tenant_id,
      content_type,
      source_id,
      slug,
      title,
      chunk_index,
      content,
      link,
      status,
      event_state,
      member_group_id,
      group_event_public,
      allowed_role_ids,
      is_public,
      published_date,
      start_date,
      feature_key,
      content_hash,
      embedding,
      source_generation,
      activation_token,
      is_active,
      access_scope,
      linked_events,
      subcategories,
      layout_type,
      microsite_id,
      source_updated_at,
      symbol_versions,
      provenance,
      embedding_model
    )
    SELECT
      tenant_id,
      content_type,
      source_id,
      slug,
      title,
      chunk_index,
      content,
      link,
      status,
      event_state,
      member_group_id,
      group_event_public,
      allowed_role_ids,
      is_public,
      published_date,
      start_date,
      feature_key,
      content_hash,
      embedding,
      source_generation,
      activation_token,
      is_active,
      access_scope,
      linked_events,
      subcategories,
      layout_type,
      microsite_id,
      source_updated_at,
      symbol_versions,
      provenance,
      embedding_model
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

  /*
   * The complete snapshot is now staged.  Remove only authored rows that are
   * not part of this activation token, plus omitted indexes from this same
   * generation.  The source lock prevents invalidation from inserting a new
   * queued job between the upsert and this cleanup.
   */
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
          SELECT 1
          FROM pg_temp.member_content_repair_rows AS r
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
    -- Defensive only: the FOR UPDATE lock makes this unreachable unless a
    -- trigger has mutated the source row.  Never report a partial publication.
    RAISE EXCEPTION 'source claim changed during repair publication';
  END IF;

  /*
   * Queue table names have changed during the member-content rollout.  Delete
   * the queued source job when one of the deployed names is present.  This is
   * dynamic solely so the focused migration remains installable in a fixture
   * that omits the optional queue; identity predicates stay parameterized.
   */
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
      )
      USING p_tenant_id, p_content_type, p_source_id;
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

-- Make the additive RPC visible to PostgREST after this transaction commits.
NOTIFY pgrst, 'reload schema';