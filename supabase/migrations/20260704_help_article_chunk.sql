-- Task #2257: Help Center AI Q&A (semantic search + citations).
-- Chunk-level embedding store for help_article bodies. Each chunk records the
-- effective feature-gate(s) that apply to it (article required_feature combined
-- with any enclosing {{feature: key}} section markers), so the ask endpoint can
-- filter retrieval to only content the asking user is allowed to see.
--
-- GLOBAL content (like help_article itself) — shared across every tenant.
-- Idempotent; safe to re-run.

-- pgvector powers the similarity search. Available on this Supabase project
-- (pg_available_extensions lists `vector`).
CREATE EXTENSION IF NOT EXISTS vector;

-- Embedding dimension for OpenAI text-embedding-3-small.
CREATE TABLE IF NOT EXISTS help_article_chunk (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  article_id uuid NOT NULL REFERENCES help_article (id) ON DELETE CASCADE,
  slug text NOT NULL,
  title text NOT NULL,
  chunk_index integer NOT NULL,
  content text NOT NULL,
  -- Effective feature-gate keys that must ALL be accessible for a reader to see
  -- this chunk. Empty array means the chunk is ungated (visible to everyone who
  -- can reach the Help Center).
  feature_gates text[] NOT NULL DEFAULT '{}',
  -- Hash of (content + feature_gates) so re-indexing can skip re-embedding
  -- chunks whose text and gates are unchanged.
  content_hash text NOT NULL DEFAULT '',
  embedding vector(1536),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- One row per (article, chunk_index); re-indexing upserts on this.
CREATE UNIQUE INDEX IF NOT EXISTS help_article_chunk_article_idx
  ON help_article_chunk (article_id, chunk_index);

-- Approximate-nearest-neighbour index for cosine distance searches.
CREATE INDEX IF NOT EXISTS help_article_chunk_embedding_idx
  ON help_article_chunk USING hnsw (embedding vector_cosine_ops);

-- Retrieval RPC: returns the closest chunks to a query embedding, along with
-- their feature gates so the caller can enforce access control in application
-- code. Cosine similarity = 1 - cosine distance.
CREATE OR REPLACE FUNCTION match_help_article_chunks(
  query_embedding vector(1536),
  match_count integer DEFAULT 20
)
RETURNS TABLE (
  id uuid,
  article_id uuid,
  slug text,
  title text,
  chunk_index integer,
  content text,
  feature_gates text[],
  similarity double precision
)
LANGUAGE sql STABLE
AS $$
  SELECT
    c.id,
    c.article_id,
    c.slug,
    c.title,
    c.chunk_index,
    c.content,
    c.feature_gates,
    1 - (c.embedding <=> query_embedding) AS similarity
  FROM help_article_chunk c
  WHERE c.embedding IS NOT NULL
  ORDER BY c.embedding <=> query_embedding
  LIMIT match_count;
$$;
