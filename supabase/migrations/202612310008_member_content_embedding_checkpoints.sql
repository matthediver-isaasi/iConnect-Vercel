-- Private durable embedding work, deliberately separate from searchable chunks.
-- Additive: no changes to either full atomic CAS publisher's contract.
BEGIN;

CREATE TABLE public.member_content_embedding_checkpoint (
  tenant_id uuid NOT NULL,
  content_type text NOT NULL,
  source_id uuid NOT NULL,
  generation bigint NOT NULL CHECK (generation > 0),
  chunk_index integer NOT NULL CHECK (chunk_index >= 0),
  content_hash text NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  embedding_model text NOT NULL CHECK (embedding_model = 'text-embedding-3-small'),
  embedding vector(1536) NOT NULL,
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '1 day'),
  PRIMARY KEY (tenant_id, content_type, source_id, generation, chunk_index, content_hash, embedding_model),
  FOREIGN KEY (tenant_id, content_type, source_id)
    REFERENCES public.member_content_source(tenant_id, content_type, source_id) ON DELETE CASCADE
);
CREATE INDEX member_content_embedding_checkpoint_expiry_idx
  ON public.member_content_embedding_checkpoint(expires_at);
ALTER TABLE public.member_content_embedding_checkpoint ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.member_content_embedding_checkpoint FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.read_member_content_embedding_checkpoints(
  p_tenant_id uuid, p_content_type text, p_source_id uuid,
  p_generation bigint, p_claim_token uuid
) RETURNS TABLE(chunk_index integer, content_hash text, embedding_model text, embedding text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  -- The same queue-row lock as publication/invalidation. A stale or expired
  -- lease cannot read staged vectors, even if it knows the generation.
  PERFORM 1 FROM public.member_content_source s
    WHERE s.tenant_id=p_tenant_id AND s.content_type=p_content_type AND s.source_id=p_source_id
      AND s.generation=p_generation AND s.claim_token=p_claim_token
      AND s.claim_started_at >= clock_timestamp() - interval '5 minutes'
    FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'MEMBER_CONTENT_GENERATION_STALE: checkpoint read rejected' USING ERRCODE='P0001';
  END IF;
  -- Opportunistic bounded-age retention, in addition to immediate source
  -- invalidation/activation cleanup below. Expired entries are never reused.
  -- Bound cleanup work and avoid waiting for checkpoints owned by another
  -- worker. This also removes expired entries for abandoned/deleted pages.
  WITH expired AS (
    SELECT c.ctid FROM public.member_content_embedding_checkpoint c
    WHERE c.expires_at<=now() ORDER BY c.expires_at
    LIMIT 500 FOR UPDATE SKIP LOCKED
  )
  DELETE FROM public.member_content_embedding_checkpoint c USING expired e WHERE c.ctid=e.ctid;
  -- Scheduled repair has a chain-wide cap. Renew surviving work while an
  -- authorised worker makes progress, so a multi-day rebuild can finish.
  UPDATE public.member_content_embedding_checkpoint c SET expires_at=now()+interval '1 day'
    WHERE c.tenant_id=p_tenant_id AND c.content_type=p_content_type AND c.source_id=p_source_id
      AND c.generation=p_generation AND c.expires_at>now();
  RETURN QUERY SELECT c.chunk_index,c.content_hash,c.embedding_model,c.embedding::text
    FROM public.member_content_embedding_checkpoint c
    WHERE c.tenant_id=p_tenant_id AND c.content_type=p_content_type AND c.source_id=p_source_id
      AND c.generation=p_generation AND c.expires_at > now();
END $$;

CREATE FUNCTION public.save_member_content_embedding_checkpoints(
  p_tenant_id uuid, p_content_type text, p_source_id uuid,
  p_generation bigint, p_claim_token uuid, p_rows jsonb
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE entry jsonb;
BEGIN
  PERFORM 1 FROM public.member_content_source s
    WHERE s.tenant_id=p_tenant_id AND s.content_type=p_content_type AND s.source_id=p_source_id
      AND s.generation=p_generation AND s.claim_token=p_claim_token
      AND s.claim_started_at >= clock_timestamp() - interval '5 minutes'
    FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'MEMBER_CONTENT_GENERATION_STALE: checkpoint write rejected' USING ERRCODE='P0001';
  END IF;
  IF p_rows IS NULL OR jsonb_typeof(p_rows) <> 'array' THEN
    RAISE EXCEPTION 'Checkpoint rows must be an array';
  END IF;
  IF jsonb_array_length(p_rows) > 2000 THEN RAISE EXCEPTION 'Checkpoint batch exceeds limit'; END IF;
  FOR entry IN SELECT value FROM jsonb_array_elements(p_rows) LOOP
    -- pgvector rejects non-finite values and enforces the model dimensions.
    INSERT INTO public.member_content_embedding_checkpoint
      (tenant_id,content_type,source_id,generation,chunk_index,content_hash,embedding_model,embedding)
    VALUES (p_tenant_id,p_content_type,p_source_id,p_generation,
      (entry->>'chunk_index')::integer,entry->>'content_hash',entry->>'embedding_model',
      (entry->>'embedding')::vector(1536))
    ON CONFLICT (tenant_id,content_type,source_id,generation,chunk_index,content_hash,embedding_model)
      DO UPDATE SET embedding=EXCLUDED.embedding,expires_at=now()+interval '1 day';
  END LOOP;
  RETURN true;
END $$;

-- Cleanup shares the source transaction; a concurrent stale checkpoint writer
-- must first acquire that row lock and will subsequently fail its CAS check.
CREATE FUNCTION public.cleanup_member_content_embedding_checkpoints()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW.generation IS DISTINCT FROM OLD.generation OR NEW.active_generation=NEW.generation THEN
    DELETE FROM public.member_content_embedding_checkpoint c
      WHERE c.tenant_id=OLD.tenant_id AND c.content_type=OLD.content_type AND c.source_id=OLD.source_id;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER member_content_embedding_checkpoint_cleanup
  AFTER UPDATE OF generation, active_generation ON public.member_content_source
  FOR EACH ROW EXECUTE FUNCTION public.cleanup_member_content_embedding_checkpoints();

REVOKE ALL ON FUNCTION public.read_member_content_embedding_checkpoints(uuid,text,uuid,bigint,uuid),
  public.save_member_content_embedding_checkpoints(uuid,text,uuid,bigint,uuid,jsonb),
  public.cleanup_member_content_embedding_checkpoints() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.read_member_content_embedding_checkpoints(uuid,text,uuid,bigint,uuid),
  public.save_member_content_embedding_checkpoints(uuid,text,uuid,bigint,uuid,jsonb) TO service_role;
NOTIFY pgrst, 'reload schema';
COMMIT;
