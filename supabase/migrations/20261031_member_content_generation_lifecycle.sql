-- Task #4435: generation-fenced Member AI indexing lifecycle.
--
-- Source-table timestamps are not a portable contract in this database.  This
-- registry is the one explicit freshness contract for source rows and their
-- transcluded/file dependencies. A source mutation immediately removes the old
-- generation from retrieval; an indexing worker stages a complete replacement
-- then atomically activates it only if its claim is still current.

CREATE TABLE IF NOT EXISTS member_content_source (
  tenant_id uuid NOT NULL,
  content_type text NOT NULL,
  source_id uuid NOT NULL,
  generation bigint NOT NULL DEFAULT 1 CHECK (generation > 0),
  active_generation bigint,
  claim_token uuid,
  claim_started_at timestamptz,
  PRIMARY KEY (tenant_id, content_type, source_id)
);

ALTER TABLE member_content_chunk
  ADD COLUMN IF NOT EXISTS source_generation bigint,
  ADD COLUMN IF NOT EXISTS activation_token uuid,
  ADD COLUMN IF NOT EXISTS is_active boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS embedding_model text;

-- Preserve the existing corpus as generation 1 until a source is edited or
-- reindexed. New rows use the generation-aware uniqueness below.
INSERT INTO member_content_source (
  tenant_id, content_type, source_id, generation, active_generation
)
SELECT DISTINCT tenant_id, content_type, source_id, 1, 1
FROM member_content_chunk
ON CONFLICT (tenant_id, content_type, source_id) DO NOTHING;

UPDATE member_content_chunk
SET source_generation = COALESCE(source_generation, 1),
    is_active = true,
    embedding_model = COALESCE(embedding_model, 'text-embedding-3-small')
WHERE source_generation IS NULL
   OR embedding_model IS NULL;

ALTER TABLE member_content_chunk
  ALTER COLUMN source_generation SET NOT NULL;

INSERT INTO member_content_source (
  tenant_id, content_type, source_id, generation, active_generation
)
SELECT tenant_id, 'canvas_symbol', id, 1, 1
FROM canvas_symbol
ON CONFLICT (tenant_id, content_type, source_id) DO NOTHING;

INSERT INTO member_content_source (
  tenant_id, content_type, source_id, generation, active_generation
)
SELECT tenant_id, 'file_repository', id, 1, 1
FROM file_repository
ON CONFLICT (tenant_id, content_type, source_id) DO NOTHING;

DROP INDEX IF EXISTS member_content_chunk_source_idx;
CREATE UNIQUE INDEX IF NOT EXISTS member_content_chunk_generation_idx
  ON member_content_chunk (
    tenant_id, content_type, source_id, chunk_index, source_generation
  );
CREATE INDEX IF NOT EXISTS member_content_chunk_active_generation_idx
  ON member_content_chunk (
    tenant_id, content_type, source_id, source_generation
  ) WHERE is_active;

-- Mutation-triggered work survives a serverless fire-and-forget hook. One row
-- per source coalesces an edit storm and records retry state for the cron and
-- platform rebuild paths.
CREATE TABLE IF NOT EXISTS member_content_reindex_job (
  tenant_id uuid NOT NULL,
  content_type text NOT NULL,
  source_id uuid NOT NULL,
  attempts integer NOT NULL DEFAULT 0,
  available_at timestamptz NOT NULL DEFAULT now(),
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, content_type, source_id)
);
CREATE INDEX IF NOT EXISTS member_content_reindex_job_due_idx
  ON member_content_reindex_job (available_at, tenant_id);

-- Invoked by source/dependency table triggers. `active_generation = NULL`
-- fails closed while an embedding replacement is pending.
DROP FUNCTION IF EXISTS invalidate_member_content_source(uuid, text, uuid, boolean);
CREATE OR REPLACE FUNCTION invalidate_member_content_source(
  p_tenant_id uuid,
  p_content_type text,
  p_source_id uuid
) RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  IF p_tenant_id IS NULL OR p_content_type IS NULL OR p_source_id IS NULL THEN
    RETURN;
  END IF;
  INSERT INTO member_content_source (
    tenant_id, content_type, source_id, generation, active_generation,
    claim_token, claim_started_at
  ) VALUES (
    p_tenant_id, p_content_type, p_source_id, 1,
    CASE WHEN p_content_type IN ('canvas_symbol', 'file_repository') THEN 1 ELSE NULL END, NULL, NULL
  )
  ON CONFLICT (tenant_id, content_type, source_id) DO UPDATE
  SET generation = member_content_source.generation + 1,
      -- A file/symbol has no chunks of its own. Its generation must remain
      -- readable as a dependency snapshot immediately; consumers with its old
      -- snapshot still fail because their generation no longer matches.
      active_generation = CASE
        WHEN p_content_type IN ('canvas_symbol', 'file_repository') THEN member_content_source.generation + 1
        ELSE NULL
      END,
      claim_token = NULL,
      claim_started_at = NULL;
  -- Dependencies fence consumers directly and are rebuilt through their
  -- dependent-source hook; only actual corpus sources need a queued worker.
  IF p_content_type IN (
    'resource', 'event', 'complex_event', 'news_post', 'blog_post', 'canvas_page'
  ) THEN
    INSERT INTO member_content_reindex_job (
      tenant_id, content_type, source_id, attempts, available_at, last_error, updated_at
    ) VALUES (p_tenant_id, p_content_type, p_source_id, 0, now(), NULL, now())
    ON CONFLICT (tenant_id, content_type, source_id) DO UPDATE
    SET attempts = 0, available_at = now(), last_error = NULL, updated_at = now();
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION member_content_source_change_trigger()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  row_data jsonb;
BEGIN
  IF TG_OP = 'DELETE' THEN
    row_data := to_jsonb(OLD);
  ELSE
    row_data := to_jsonb(NEW);
  END IF;
  PERFORM invalidate_member_content_source(
    (row_data->>'tenant_id')::uuid,
    TG_ARGV[0],
    (row_data->>'id')::uuid
  );
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

-- Every authoring write invalidates retrieval even if it bypasses an API hook.
DO $$
DECLARE
  spec record;
BEGIN
  FOR spec IN SELECT * FROM (VALUES
    ('resource', 'resource', 'title,description,target_url,resource_type,author_name,tags,subcategories,status,member_group_id,allowed_role_ids,is_public,linked_events,tenant_id'),
    ('event', 'event', 'title,slug,summary,description,location,start_date,event_type,is_online,status,event_state,member_group_id,group_event_public,tenant_id'),
    ('complex_event', 'complex_event', 'title,slug,summary,description,location,start_date,event_type,is_online,status,event_state,member_group_id,group_event_public,tenant_id'),
    ('news_post', 'news_post', 'title,slug,summary,content,author_name,tags,status,published_date,tenant_id'),
    ('blog_post', 'blog_post', 'title,slug,summary,content,tags,status,published_date,tenant_id'),
    ('i_edit_page', 'canvas_page', 'title,slug,canvas_design,status,layout_type,builder_type,microsite_id,tenant_id'),
    ('canvas_symbol', 'canvas_symbol', 'name,description,design,tenant_id'),
    ('file_repository', 'file_repository', 'file_url,file_name,file_type,mime_type,file_size,bucket,storage_path,folder_id,tenant_id')
  ) AS x(table_name, content_type, update_columns)
  LOOP
    IF to_regclass('public.' || spec.table_name) IS NULL THEN
      CONTINUE;
    END IF;
    EXECUTE format('DROP TRIGGER IF EXISTS member_content_source_change ON %I', spec.table_name);
    EXECUTE format(
      'CREATE TRIGGER member_content_source_change AFTER INSERT OR DELETE OR UPDATE OF %s ON %I FOR EACH ROW EXECUTE FUNCTION member_content_source_change_trigger(%L)',
      spec.update_columns, spec.table_name, spec.content_type
    );
  END LOOP;
END $$;

-- Exactly one worker may stage a source generation. A stale claim is fairly
-- reclaimable by cron/platform after five minutes; an update invalidates any
-- outstanding token immediately.
DROP FUNCTION IF EXISTS claim_member_content_generation(uuid, text, uuid);
CREATE OR REPLACE FUNCTION claim_member_content_generation(
  p_tenant_id uuid,
  p_content_type text,
  p_source_id uuid
) RETURNS TABLE (generation bigint, claim_token uuid, already_active boolean)
LANGUAGE plpgsql
AS $$
DECLARE
  token uuid := gen_random_uuid();
BEGIN
  INSERT INTO member_content_source (
    tenant_id, content_type, source_id, generation, active_generation
  ) VALUES (p_tenant_id, p_content_type, p_source_id, 1, NULL)
  ON CONFLICT (tenant_id, content_type, source_id) DO NOTHING;
  UPDATE member_content_source AS source
  SET claim_token = token,
      claim_started_at = now()
  WHERE source.tenant_id = p_tenant_id
    AND source.content_type = p_content_type
    AND source.source_id = p_source_id
    AND (
      source.claim_token IS NULL
      OR source.claim_started_at < now() - interval '5 minutes'
    )
  RETURNING source.generation, source.claim_token,
    source.active_generation = source.generation
  INTO generation, claim_token, already_active;
  RETURN NEXT;
END;
$$;

-- Activation is a transaction boundary. Rows are invisible until this
-- conditional update succeeds, so a stale worker can never publish old text.
CREATE OR REPLACE FUNCTION activate_member_content_generation(
  p_tenant_id uuid,
  p_content_type text,
  p_source_id uuid,
  p_generation bigint,
  p_claim_token uuid
) RETURNS boolean
LANGUAGE plpgsql
AS $$
DECLARE
  activated boolean := false;
BEGIN
  UPDATE member_content_source
  SET active_generation = p_generation,
      claim_token = NULL,
      claim_started_at = NULL
  WHERE tenant_id = p_tenant_id
    AND content_type = p_content_type
    AND source_id = p_source_id
    AND generation = p_generation
    AND claim_token = p_claim_token
  RETURNING true INTO activated;
  IF NOT COALESCE(activated, false) THEN
    RETURN false;
  END IF;

  UPDATE member_content_chunk
  SET is_active = true
  WHERE tenant_id = p_tenant_id
    AND content_type = p_content_type
    AND source_id = p_source_id
    AND source_generation = p_generation
    AND activation_token = p_claim_token;

  DELETE FROM member_content_chunk
  WHERE tenant_id = p_tenant_id
    AND content_type = p_content_type
    AND source_id = p_source_id
    AND (
      source_generation <> p_generation
      OR (source_generation = p_generation AND activation_token IS DISTINCT FROM p_claim_token)
    );

  RETURN true;
END;
$$;

-- The access/RPC contract is: inner join this registry and require
-- `chunk.source_generation = source.active_generation AND chunk.is_active`.
-- Dependency records in chunk.provenance use the same registry rows with
-- content_type canvas_symbol or file_repository.

-- Hybrid retrieval remains policy-first: the CTE performs every tenant,
-- publication, RBAC, group, category and event/session predicate before either
-- lexical or vector score is calculated or a LIMIT is applied. Lexical ranking
-- makes exact titles, dates and event names reliably findable while semantic
-- ranking remains the dominant signal.
CREATE INDEX IF NOT EXISTS member_content_chunk_lexical_idx
  ON member_content_chunk
  USING gin (to_tsvector('simple', coalesce(title, '') || ' ' || coalesce(content, '')));

DROP FUNCTION IF EXISTS match_member_content_chunks(
  vector, uuid, integer, boolean, boolean, uuid, uuid[], uuid[], uuid[], text[], text[]
);
DROP FUNCTION IF EXISTS match_member_content_chunks(
  vector, uuid, integer, boolean, boolean, uuid, uuid[], uuid[], uuid[], text[], text[], text
);
DROP FUNCTION IF EXISTS match_member_content_chunks(
  vector, uuid, integer, boolean, boolean, uuid, uuid[], uuid[], uuid[], text[], text[], text, text[]
);

CREATE FUNCTION match_member_content_chunks(
  query_embedding vector(1536),
  p_tenant_id uuid,
  match_count integer DEFAULT 30,
  p_is_authenticated boolean DEFAULT false,
  p_is_admin boolean DEFAULT false,
  p_role_id uuid DEFAULT NULL,
  p_group_ids uuid[] DEFAULT ARRAY[]::uuid[],
  p_accessible_event_ids uuid[] DEFAULT ARRAY[]::uuid[],
  p_accessible_session_ids uuid[] DEFAULT ARRAY[]::uuid[],
  p_hidden_subcategories text[] DEFAULT ARRAY[]::text[],
  p_allowed_feature_keys text[] DEFAULT ARRAY[]::text[],
  p_query_text text DEFAULT '',
  p_allowed_content_types text[] DEFAULT ARRAY['resource','event','complex_event','news_post','blog_post','canvas_page']
)
RETURNS TABLE (
  id uuid, tenant_id uuid, content_type text, source_id uuid, slug text,
  title text, chunk_index integer, content text, link text, status text,
  event_state text, member_group_id uuid, group_event_public boolean,
  allowed_role_ids uuid[], is_public boolean, published_date timestamptz,
  start_date timestamptz, feature_key text, access_scope text,
  linked_events jsonb, subcategories text[], layout_type text,
  microsite_id uuid, source_generation bigint, provenance jsonb,
  similarity double precision
)
LANGUAGE sql STABLE
AS $$
  WITH eligible AS (
    SELECT c.*
    FROM member_content_chunk c
    INNER JOIN member_content_source s
      ON s.tenant_id = c.tenant_id
     AND s.content_type = c.content_type
     AND s.source_id = c.source_id
     AND s.active_generation = c.source_generation
    WHERE c.embedding IS NOT NULL
      AND c.is_active IS TRUE
      AND c.tenant_id = p_tenant_id
      AND c.content_type = ANY(p_allowed_content_types)
      AND (c.access_scope = 'public' OR p_is_authenticated)
      AND (c.feature_key IS NULL OR c.feature_key = ANY(p_allowed_feature_keys))
      AND (
        (c.content_type = 'resource' AND c.status = 'active')
        OR (c.content_type = 'event' AND c.status IN ('published', 'tbc', 'immediate') AND COALESCE(c.event_state, '') <> 'draft')
        OR (c.content_type = 'complex_event' AND c.status IN ('published', 'tbc') AND COALESCE(c.event_state, '') <> 'draft')
        OR (c.content_type IN ('news_post', 'blog_post') AND c.status = 'published' AND (c.published_date IS NULL OR c.published_date <= now()))
        OR (c.content_type = 'canvas_page' AND c.status = 'published')
      )
      AND (
        p_is_admin OR c.content_type <> 'resource' OR (
          (c.member_group_id IS NULL OR c.member_group_id = ANY(p_group_ids))
          AND (c.is_public IS TRUE OR (p_is_authenticated AND p_role_id IS NOT NULL))
          AND (COALESCE(array_length(c.allowed_role_ids, 1), 0) = 0 OR p_role_id = ANY(c.allowed_role_ids))
          AND (
            c.linked_events IS NULL OR c.linked_events = '[]'::jsonb OR EXISTS (
              SELECT 1 FROM jsonb_array_elements(c.linked_events) AS link(value)
              WHERE CASE WHEN link.value->>'event_id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                THEN (link.value->>'event_id')::uuid = ANY(p_accessible_event_ids) ELSE false END
              AND (link.value->>'session_id' IS NULL OR (
                link.value->>'session_id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                AND (link.value->>'session_id')::uuid = ANY(p_accessible_session_ids)
              ))
            )
          )
          AND NOT (COALESCE(array_length(c.subcategories, 1), 0) > 0 AND c.subcategories <@ p_hidden_subcategories)
        )
      )
      AND (
        p_is_admin OR c.content_type NOT IN ('event', 'complex_event')
        OR c.member_group_id IS NULL OR c.group_event_public IS TRUE
        OR c.member_group_id = ANY(p_group_ids)
      )
  ),
  scored AS (
    SELECT e.*,
      (1 - (e.embedding <=> query_embedding)) AS semantic_score,
      CASE WHEN btrim(p_query_text) = '' THEN 0::real
        ELSE ts_rank_cd(
          to_tsvector('simple', coalesce(e.title, '') || ' ' || coalesce(e.content, '')),
          websearch_to_tsquery('simple', p_query_text)
        ) END AS lexical_score
    FROM eligible e
  )
  SELECT
    id, tenant_id, content_type, source_id, slug, title, chunk_index, content,
    link, status, event_state, member_group_id, group_event_public,
    allowed_role_ids, is_public, published_date, start_date, feature_key,
    access_scope, linked_events, subcategories, layout_type, microsite_id,
    source_generation, provenance,
    (semantic_score * 0.82 + lexical_score * 0.18)::double precision AS similarity
  FROM scored
  ORDER BY (semantic_score * 0.82 + lexical_score * 0.18) DESC, id
  LIMIT LEAST(GREATEST(match_count, 1), 100);
$$;

REVOKE ALL ON FUNCTION match_member_content_chunks(
  vector, uuid, integer, boolean, boolean, uuid, uuid[], uuid[], uuid[], text[], text[], text, text[]
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION match_member_content_chunks(
  vector, uuid, integer, boolean, boolean, uuid, uuid[], uuid[], uuid[], text[], text[], text, text[]
) TO service_role;