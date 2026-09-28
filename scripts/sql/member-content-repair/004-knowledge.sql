-- Additive knowledge publisher: keep the deployed authored-repair contract
-- untouched. Only the knowledge adapter can publish mixed-access/PDF rows.
CREATE OR REPLACE FUNCTION public.publish_member_content_knowledge(
  p_tenant_id uuid, p_content_type text, p_source_id uuid,
  p_generation bigint, p_claim_token uuid, p_rows jsonb
) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  source_table text;
  canonical jsonb;
  registry record;
  dependency record;
  dependency_state record;
  site_id uuid;
  site public.microsite%ROWTYPE;
  payload public.member_content_chunk%ROWTYPE;
  n integer;
BEGIN
  IF p_tenant_id IS NULL OR p_source_id IS NULL OR p_content_type IS NULL
     OR p_claim_token IS NULL OR p_generation IS NULL THEN RETURN false; END IF;
  source_table := CASE p_content_type
    WHEN 'resource' THEN 'resource' WHEN 'event' THEN 'event'
    WHEN 'complex_event' THEN 'complex_event' WHEN 'blog_post' THEN 'blog_post'
    WHEN 'news_post' THEN 'news_post' WHEN 'canvas_page' THEN 'i_edit_page' END;
  IF source_table IS NULL OR jsonb_typeof(p_rows) IS DISTINCT FROM 'array'
     OR jsonb_array_length(p_rows) > 100 THEN
    RAISE EXCEPTION 'Invalid knowledge snapshot' USING ERRCODE='22023';
  END IF;
  -- Microsite lock precedes page lock, matching the repaired publisher and FK
  -- delete ordering. Re-read page after locking, never trust a stale route.
  IF p_content_type = 'canvas_page' THEN
    SELECT microsite_id INTO site_id FROM public.i_edit_page
    WHERE tenant_id=p_tenant_id AND id=p_source_id;
    IF site_id IS NOT NULL THEN
      SELECT * INTO site FROM public.microsite
      WHERE tenant_id=p_tenant_id AND id=site_id FOR UPDATE;
    END IF;
  END IF;
  EXECUTE format('SELECT to_jsonb(t) FROM public.%I t WHERE tenant_id=$1 AND id=$2 FOR UPDATE',source_table)
    INTO canonical USING p_tenant_id,p_source_id;
  IF p_content_type='canvas_page' AND canonical IS NOT NULL
     AND (canonical->>'microsite_id')::uuid IS DISTINCT FROM site_id THEN RETURN false; END IF;
  IF canonical IS NULL AND jsonb_array_length(p_rows)>0 THEN RETURN false; END IF;
  IF jsonb_array_length(p_rows)>0 AND p_content_type='canvas_page'
     AND (canonical->>'status'<>'published' OR canonical->>'builder_type'<>'canvas'
       OR (site_id IS NOT NULL AND (site.id IS NULL OR site.is_active IS NOT TRUE))) THEN RETURN false; END IF;

  DROP TABLE IF EXISTS pg_temp.member_knowledge_rows;
  CREATE TEMP TABLE pg_temp.member_knowledge_rows ON COMMIT DROP
    AS SELECT * FROM public.member_content_chunk WITH NO DATA;
  INSERT INTO pg_temp.member_knowledge_rows
    SELECT * FROM jsonb_populate_recordset(NULL::public.member_content_chunk,p_rows);
  SELECT count(*) INTO n FROM pg_temp.member_knowledge_rows;
  IF EXISTS(SELECT 1 FROM pg_temp.member_knowledge_rows
      WHERE tenant_id IS DISTINCT FROM p_tenant_id OR source_id IS DISTINCT FROM p_source_id
      OR content_type IS DISTINCT FROM p_content_type OR source_generation IS DISTINCT FROM p_generation
      OR chunk_index IS NULL OR chunk_index<0 OR content IS NULL OR title IS NULL
      OR embedding IS NULL OR content_hash IS NULL OR embedding_model IS DISTINCT FROM 'text-embedding-3-small'
      OR access_scope IS NULL OR access_scope NOT IN ('public','authenticated')
      OR jsonb_typeof(provenance->'dependencies') IS DISTINCT FROM 'array'
      OR provenance->>'kind' IS NULL
      OR provenance->>'kind' NOT IN ('knowledge','resource_pdf','canvas_page','authored_repair'))
    OR (SELECT count(DISTINCT chunk_index) FROM pg_temp.member_knowledge_rows) <> n
    OR (SELECT coalesce(sum(octet_length(content)),0) FROM pg_temp.member_knowledge_rows)>512000
  THEN RAISE EXCEPTION 'Invalid knowledge chunk metadata' USING ERRCODE='22023'; END IF;

  -- Every dependency is locked and validated before parent CAS. File or symbol
  -- edits during extraction cannot activate a snapshot from an old generation.
  FOR dependency IN
    SELECT DISTINCT d->>'contentType' AS type,(d->>'sourceId')::uuid AS id,
      (d->>'generation')::bigint AS generation
    FROM pg_temp.member_knowledge_rows r CROSS JOIN LATERAL jsonb_array_elements(r.provenance->'dependencies') d
    ORDER BY 1,2,3
  LOOP
    IF dependency.type NOT IN ('file_repository','canvas_symbol') OR dependency.generation IS NULL THEN
      RAISE EXCEPTION 'Invalid knowledge dependency' USING ERRCODE='22023';
    END IF;
    SELECT generation,active_generation INTO dependency_state FROM public.member_content_source
      WHERE tenant_id=p_tenant_id AND content_type=dependency.type AND source_id=dependency.id FOR UPDATE;
    IF NOT FOUND OR dependency_state.generation IS DISTINCT FROM dependency.generation
       OR dependency_state.active_generation IS DISTINCT FROM dependency.generation THEN RETURN false; END IF;
  END LOOP;
  IF EXISTS(SELECT 1 FROM pg_temp.member_knowledge_rows r WHERE r.provenance->>'kind'='resource_pdf'
    AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(r.provenance->'dependencies') d
      WHERE d->>'contentType'='file_repository' AND d->>'sourceId'=r.provenance->>'fileId'))
  THEN RAISE EXCEPTION 'PDF file fence missing' USING ERRCODE='22023'; END IF;
  SELECT * INTO registry FROM public.member_content_source
    WHERE tenant_id=p_tenant_id AND content_type=p_content_type AND source_id=p_source_id FOR UPDATE;
  IF NOT FOUND OR registry.generation IS DISTINCT FROM p_generation
    OR registry.claim_token IS DISTINCT FROM p_claim_token
    OR registry.claim_started_at IS NULL OR registry.claim_started_at<now()-interval '5 minutes'
  THEN RETURN false; END IF;

  -- Whole-source replacement is one transaction: readers see the preceding
  -- complete generation or the new one, never a partially staged same-generation
  -- overwrite. No browser role has direct access or execute permission.
  UPDATE pg_temp.member_knowledge_rows r SET id=c.id,created_at=c.created_at
    FROM public.member_content_chunk c WHERE c.tenant_id=p_tenant_id AND c.content_type=p_content_type
    AND c.source_id=p_source_id AND c.source_generation=p_generation AND c.chunk_index=r.chunk_index;
  DELETE FROM public.member_content_chunk
    WHERE tenant_id=p_tenant_id AND content_type=p_content_type AND source_id=p_source_id;
  FOR payload IN SELECT * FROM pg_temp.member_knowledge_rows ORDER BY chunk_index LOOP
    payload.id:=coalesce(payload.id,gen_random_uuid());
    payload.is_active:=true;
    payload.activation_token:=p_claim_token;
    payload.created_at:=coalesce(payload.created_at,now());
    payload.updated_at:=now();
    INSERT INTO public.member_content_chunk SELECT (payload).*;
  END LOOP;
  UPDATE public.member_content_source SET active_generation=p_generation,claim_token=NULL,claim_started_at=NULL
    WHERE tenant_id=p_tenant_id AND content_type=p_content_type AND source_id=p_source_id;
  DELETE FROM public.member_content_reindex_job
    WHERE tenant_id=p_tenant_id AND content_type=p_content_type AND source_id=p_source_id;
  RETURN true;
END;
$$;
REVOKE ALL ON FUNCTION public.publish_member_content_knowledge(uuid,text,uuid,bigint,uuid,jsonb)
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.publish_member_content_knowledge(uuid,text,uuid,bigint,uuid,jsonb) TO service_role;