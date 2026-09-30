-- Task #2363: Member AI Knowledge Assistant (semantic search + citations).
-- Chunk-level embedding store for member-facing content: resources, events
-- (event + complex_event), news_post, and blog_post. Each chunk carries the
-- visibility metadata needed to re-check, at RETRIEVAL time, that the asking
-- member would be allowed to SEE the underlying content on the portal. The
-- retrieval filter IS the security boundary.
--
-- TENANT-scoped content (unlike the GLOBAL help_article_chunk). Every row is
-- keyed by tenant_id and the match RPC hard-filters on it.
-- Idempotent; safe to re-run.

-- pgvector powers the similarity search.
CREATE EXTENSION IF NOT EXISTS vector;

-- Embedding dimension for OpenAI text-embedding-3-small (1536).
CREATE TABLE IF NOT EXISTS member_content_chunk (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  -- One of: resource | event | complex_event | news_post | blog_post
  content_type text NOT NULL,
  source_id uuid NOT NULL,
  slug text,
  title text NOT NULL,
  chunk_index integer NOT NULL,
  content text NOT NULL,
  -- In-portal route to the source content, used to render clickable citations.
  link text,
  -- Visibility metadata mirrored from the source row so the ask endpoint can
  -- re-apply the exact browse rules without a second round-trip per candidate.
  status text,
  event_state text,
  member_group_id uuid,
  group_event_public boolean,
  allowed_role_ids uuid[],
  is_public boolean,
  published_date timestamptz,
  start_date timestamptz,
  -- Feature key that gates this content type in RBAC (e.g. content.resources).
  feature_key text,
  -- Hash of the chunk content so re-indexing can skip re-embedding unchanged
  -- chunks (visibility metadata is always re-written).
  content_hash text NOT NULL DEFAULT '',
  embedding vector(1536),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- One row per (content_type, source_id, chunk_index); re-indexing upserts here.
CREATE UNIQUE INDEX IF NOT EXISTS member_content_chunk_source_idx
  ON member_content_chunk (content_type, source_id, chunk_index);

-- Tenant scoping for cheap deletes / scans.
CREATE INDEX IF NOT EXISTS member_content_chunk_tenant_idx
  ON member_content_chunk (tenant_id);

-- Approximate-nearest-neighbour index for cosine distance searches.
CREATE INDEX IF NOT EXISTS member_content_chunk_embedding_idx
  ON member_content_chunk USING hnsw (embedding vector_cosine_ops);

-- Retrieval RPC: returns the closest chunks to a query embedding WITHIN a
-- single tenant, along with the visibility metadata so the caller can enforce
-- per-member access control in application code. Cosine similarity = 1 - cosine
-- distance. Tenant isolation is enforced here (not left to the caller).
CREATE OR REPLACE FUNCTION match_member_content_chunks(
  query_embedding vector(1536),
  p_tenant_id uuid,
  match_count integer DEFAULT 30
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
  similarity double precision
)
LANGUAGE sql STABLE
AS $$
  SELECT
    c.id,
    c.tenant_id,
    c.content_type,
    c.source_id,
    c.slug,
    c.title,
    c.chunk_index,
    c.content,
    c.link,
    c.status,
    c.event_state,
    c.member_group_id,
    c.group_event_public,
    c.allowed_role_ids,
    c.is_public,
    c.published_date,
    c.start_date,
    c.feature_key,
    1 - (c.embedding <=> query_embedding) AS similarity
  FROM member_content_chunk c
  WHERE c.embedding IS NOT NULL
    AND c.tenant_id = p_tenant_id
  ORDER BY c.embedding <=> query_embedding
  LIMIT match_count;
$$;
