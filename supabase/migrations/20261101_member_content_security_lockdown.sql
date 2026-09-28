-- P0: Member-content corpus is server-side infrastructure, never a browser
-- data surface.  Lock down both the source registry and chunks explicitly;
-- do not depend on Supabase's default grants or an absent RLS policy.

DO $$
DECLARE
  policy_row record;
BEGIN
  FOR policy_row IN
    SELECT schemaname, tablename, policyname
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename IN (
        'member_content_chunk', 'member_content_source', 'member_content_reindex_job'
      )
  LOOP
    EXECUTE format(
      'DROP POLICY IF EXISTS %I ON %I.%I',
      policy_row.policyname, policy_row.schemaname, policy_row.tablename
    );
  END LOOP;
END $$;

ALTER TABLE public.member_content_chunk ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.member_content_chunk FORCE ROW LEVEL SECURITY;
ALTER TABLE public.member_content_source ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.member_content_source FORCE ROW LEVEL SECURITY;
ALTER TABLE public.member_content_reindex_job ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.member_content_reindex_job FORCE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.member_content_chunk FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.member_content_source FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.member_content_reindex_job FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.member_content_chunk TO service_role;
GRANT ALL ON TABLE public.member_content_source TO service_role;
GRANT ALL ON TABLE public.member_content_reindex_job TO service_role;

CREATE POLICY member_content_chunk_service_role_only
  ON public.member_content_chunk
  AS PERMISSIVE
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

CREATE POLICY member_content_source_service_role_only
  ON public.member_content_source
  AS PERMISSIVE
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

CREATE POLICY member_content_reindex_job_service_role_only
  ON public.member_content_reindex_job
  AS PERMISSIVE
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- Worker lifecycle RPCs mutate the corpus and must be service-only too.
REVOKE ALL ON FUNCTION public.invalidate_member_content_source(uuid, text, uuid)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.claim_member_content_generation(uuid, text, uuid)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.activate_member_content_generation(uuid, text, uuid, bigint, uuid)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.member_content_source_change_trigger()
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.invalidate_member_content_source(uuid, text, uuid)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.claim_member_content_generation(uuid, text, uuid)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.activate_member_content_generation(uuid, text, uuid, bigint, uuid)
  TO service_role;

-- Canonicalize matcher identity before recreating it. Previous deployments
-- produced several overloads as access parameters evolved; merely revoking one
-- signature leaves an anonymous-callable sibling behind, and CREATE FUNCTION
-- then fails on a rerun when its final signature already exists. Every
-- overload has the same server-only purpose, so remove every one by identity
-- and create precisely one required-argument contract below.
DO $$
DECLARE
  matcher record;
BEGIN
  FOR matcher IN
    SELECT p.oid::regprocedure AS identity
    FROM pg_proc p
    INNER JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname = 'match_member_content_chunks'
  LOOP
    EXECUTE format('DROP FUNCTION %s', matcher.identity);
  END LOOP;
END $$;

-- Replace the generation-aware matcher with a signature that accepts the
-- authoritative pre-ranked PDF allow-list.  The server computes that list from
-- current resource/file/folder/gallery policy data.  Source dependencies are
-- also joined against their active registry generations here, before score or
-- LIMIT, so stale derived text cannot crowd out eligible content.
CREATE FUNCTION public.match_member_content_chunks(
  query_embedding vector(1536),
  p_tenant_id uuid,
  match_count integer,
  p_is_authenticated boolean,
  p_is_admin boolean,
  p_role_id uuid,
  p_group_ids uuid[],
  p_accessible_event_ids uuid[],
  p_accessible_session_ids uuid[],
  p_hidden_subcategories text[],
  p_allowed_feature_keys text[],
  p_eligible_pdf_chunk_ids uuid[],
  p_query_text text,
  p_allowed_content_types text[]
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
    FROM public.member_content_chunk c
    INNER JOIN public.member_content_source s
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
      -- Reject malformed dependency metadata, and require every declared
      -- dependency to be currently active at exactly its indexed generation.
      AND (
        c.provenance->'dependencies' IS NULL
        OR jsonb_typeof(c.provenance->'dependencies') = 'array'
      )
      AND NOT EXISTS (
        SELECT 1
        FROM jsonb_array_elements(
          CASE WHEN jsonb_typeof(c.provenance->'dependencies') = 'array'
            THEN c.provenance->'dependencies'
            ELSE '[]'::jsonb
          END
        ) AS dependency(value)
        LEFT JOIN public.member_content_source dependency_source
          ON dependency_source.tenant_id = c.tenant_id
         AND dependency_source.content_type = dependency.value->>'contentType'
         AND dependency_source.source_id::text = dependency.value->>'sourceId'
        WHERE dependency_source.active_generation IS NULL
           OR dependency_source.active_generation::text
              IS DISTINCT FROM dependency.value->>'generation'
      )
      -- PDF file/folder/gallery checks are completed by the server before this
      -- query.  Require a real file dependency as well as a pre-authorized
      -- chunk id; an empty list safely excludes every derived PDF.
      AND (
        COALESCE(c.provenance->>'kind', '') <> 'resource_pdf'
        OR (
          c.id = ANY(p_eligible_pdf_chunk_ids)
          AND jsonb_typeof(c.provenance->'dependencies') = 'array'
          AND EXISTS (
            SELECT 1
            FROM jsonb_array_elements(c.provenance->'dependencies') AS file_dependency(value)
            WHERE file_dependency.value->>'contentType' = 'file_repository'
              AND file_dependency.value->>'sourceId' = c.provenance->>'fileId'
          )
        )
      )
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

REVOKE ALL ON FUNCTION public.match_member_content_chunks(
  vector, uuid, integer, boolean, boolean, uuid, uuid[], uuid[], uuid[], text[], text[], uuid[], text, text[]
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.match_member_content_chunks(
  vector, uuid, integer, boolean, boolean, uuid, uuid[], uuid[], uuid[], text[], text[], uuid[], text, text[]
) TO service_role;