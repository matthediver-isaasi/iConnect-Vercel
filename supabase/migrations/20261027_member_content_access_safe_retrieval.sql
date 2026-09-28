-- Task #4435: Permission-aware member knowledge retrieval.
-- Additive evolution of the existing member_content_chunk corpus.  Existing
-- rows remain public projections; new index runs write per-chunk access
-- metadata. The RPC applies current viewer predicates before ORDER/LIMIT.

ALTER TABLE member_content_chunk
  ADD COLUMN IF NOT EXISTS access_scope text NOT NULL DEFAULT 'public',
  ADD COLUMN IF NOT EXISTS linked_events jsonb,
  ADD COLUMN IF NOT EXISTS subcategories text[],
  ADD COLUMN IF NOT EXISTS layout_type text,
  ADD COLUMN IF NOT EXISTS microsite_id uuid,
  ADD COLUMN IF NOT EXISTS source_updated_at timestamptz,
  ADD COLUMN IF NOT EXISTS symbol_versions jsonb,
  ADD COLUMN IF NOT EXISTS provenance jsonb NOT NULL DEFAULT '{}'::jsonb;

-- Legacy Canvas chunks were created from the unprojected canvas document.
-- Keep them fail-closed for anonymous callers until the next reindex replaces
-- them with separate public/authenticated projections.
UPDATE member_content_chunk
SET access_scope = 'authenticated'
WHERE content_type = 'canvas_page' AND access_scope = 'public';

ALTER TABLE member_content_chunk
  DROP CONSTRAINT IF EXISTS member_content_chunk_access_scope_check;
ALTER TABLE member_content_chunk
  ADD CONSTRAINT member_content_chunk_access_scope_check
  CHECK (access_scope IN ('public', 'authenticated'));

CREATE INDEX IF NOT EXISTS member_content_chunk_access_lookup_idx
  ON member_content_chunk (tenant_id, content_type, status, access_scope);

-- This RPC is server-side only in application use. It accepts no browser
-- supplied authority: ask.js derives every parameter from the verified session
-- and current DB entitlement rows. The source rows are then revalidated before
-- model context is constructed, handling changes which metadata alone cannot.
-- Replace the initial access-aware overload rather than leave two callable
-- versions with different security predicates.  The original 3-argument
-- overload is explicitly revoked below; service code must use this form.
DROP FUNCTION IF EXISTS match_member_content_chunks(
  vector, uuid, integer, boolean, boolean, uuid, uuid[], uuid[], text[], text[]
);

CREATE OR REPLACE FUNCTION match_member_content_chunks(
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
  p_allowed_feature_keys text[] DEFAULT ARRAY[]::text[]
)
RETURNS TABLE (
  id uuid,
  tenant_id uuid,
  content_type text,
  source_id uuid,
  slug text,
  title text,
  chunk_index integer,
  content text,
  link text,
  status text,
  event_state text,
  member_group_id uuid,
  group_event_public boolean,
  allowed_role_ids uuid[],
  is_public boolean,
  published_date timestamptz,
  start_date timestamptz,
  feature_key text,
  access_scope text,
  linked_events jsonb,
  subcategories text[],
  layout_type text,
  microsite_id uuid,
  source_updated_at timestamptz,
  symbol_versions jsonb,
  provenance jsonb,
  similarity double precision
)
LANGUAGE sql STABLE
AS $$
  SELECT
    c.id, c.tenant_id, c.content_type, c.source_id, c.slug, c.title,
    c.chunk_index, c.content, c.link, c.status, c.event_state,
    c.member_group_id, c.group_event_public, c.allowed_role_ids, c.is_public,
    c.published_date, c.start_date, c.feature_key, c.access_scope,
    c.linked_events, c.subcategories, c.layout_type, c.microsite_id,
    c.source_updated_at,
    c.symbol_versions,
    c.provenance,
    1 - (c.embedding <=> query_embedding) AS similarity
  FROM member_content_chunk c
  WHERE c.embedding IS NOT NULL
    AND c.tenant_id = p_tenant_id
    AND (c.access_scope = 'public' OR p_is_authenticated)
    AND (c.feature_key IS NULL OR c.feature_key = ANY(p_allowed_feature_keys))
    AND (
      (c.content_type = 'resource' AND c.status = 'active')
      OR (
        c.content_type = 'event'
        AND c.status IN ('published', 'tbc', 'immediate')
        AND COALESCE(c.event_state, '') <> 'draft'
      )
      OR (
        c.content_type = 'complex_event'
        AND c.status IN ('published', 'tbc')
        AND COALESCE(c.event_state, '') <> 'draft'
      )
      OR (
        c.content_type IN ('news_post', 'blog_post')
        AND c.status = 'published'
        AND (c.published_date IS NULL OR c.published_date <= now())
      )
      OR (c.content_type = 'canvas_page' AND c.status = 'published')
    )
    AND (
      p_is_admin
      OR c.content_type <> 'resource'
      OR (
        (c.member_group_id IS NULL OR c.member_group_id = ANY(p_group_ids))
        -- Non-public resources require a resolved member role.  An empty
        -- allowed_role_ids array is not a tenant-wide grant: it must not turn
        -- a role-less member session into access to a protected resource.
        AND (
          c.is_public IS TRUE
          OR (p_is_authenticated AND p_role_id IS NOT NULL)
        )
        AND (
          COALESCE(array_length(c.allowed_role_ids, 1), 0) = 0
          OR p_role_id = ANY(c.allowed_role_ids)
        )
        -- An event-linked resource is only eligible when the viewer has a
        -- current confirmed entitlement to one of its linked events.
        AND (
          c.linked_events IS NULL OR c.linked_events = '[]'::jsonb
          OR EXISTS (
            SELECT 1
            FROM jsonb_array_elements(c.linked_events) AS link(value)
            WHERE
              CASE
                WHEN link.value->>'event_id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                THEN (link.value->>'event_id')::uuid = ANY(p_accessible_event_ids)
                ELSE false
              END
              AND (
                link.value->>'session_id' IS NULL
                OR (
                  link.value->>'session_id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                  AND (link.value->>'session_id')::uuid = ANY(p_accessible_session_ids)
                )
              )
          )
        )
        AND NOT (
          COALESCE(array_length(c.subcategories, 1), 0) > 0
          AND c.subcategories <@ p_hidden_subcategories
        )
      )
    )
    AND (
      p_is_admin
      OR c.content_type NOT IN ('event', 'complex_event')
      OR (
        c.member_group_id IS NULL
        OR c.group_event_public IS TRUE
        OR c.member_group_id = ANY(p_group_ids)
      )
    )
  ORDER BY c.embedding <=> query_embedding
  LIMIT LEAST(GREATEST(match_count, 1), 100);
$$;

REVOKE ALL ON FUNCTION match_member_content_chunks(
  vector, uuid, integer, boolean, boolean, uuid, uuid[], uuid[], uuid[], text[], text[]
) FROM PUBLIC;
REVOKE ALL ON FUNCTION match_member_content_chunks(vector, uuid, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION match_member_content_chunks(
  vector, uuid, integer, boolean, boolean, uuid, uuid[], uuid[], uuid[], text[], text[]
) TO service_role;