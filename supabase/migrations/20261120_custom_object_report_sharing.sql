-- External report capabilities are separate from member/admin sessions.
BEGIN;
CREATE TABLE IF NOT EXISTS public.custom_object_report_share (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  custom_object_id uuid NOT NULL,
  report_id text NOT NULL CHECK (length(report_id) BETWEEN 1 AND 128),
  enabled boolean NOT NULL DEFAULT false,
  password_required boolean NOT NULL DEFAULT true,
  password_hash text,
  allow_csv boolean NOT NULL DEFAULT false,
  link_nonce uuid NOT NULL DEFAULT gen_random_uuid(),
  token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  revision bigint NOT NULL DEFAULT 1 CHECK (revision>0),
  name text NOT NULL,
  definition jsonb NOT NULL,
  source_hash text NOT NULL CHECK (source_hash ~ '^[a-f0-9]{64}$'),
  updated_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(tenant_id,id),
  UNIQUE(tenant_id,custom_object_id,report_id),
  CHECK (NOT enabled OR NOT password_required OR password_hash IS NOT NULL)
);
CREATE TABLE IF NOT EXISTS public.custom_object_report_share_grant (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  share_id uuid NOT NULL,
  revision bigint NOT NULL,
  token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(tenant_id,id),
  FOREIGN KEY(tenant_id,share_id) REFERENCES public.custom_object_report_share(tenant_id,id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS custom_object_report_share_grant_expiry ON public.custom_object_report_share_grant(expires_at);
ALTER TABLE public.custom_object_report_share ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.custom_object_report_share_grant ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.custom_object_report_share, public.custom_object_report_share_grant FROM PUBLIC,anon,authenticated;
GRANT ALL ON public.custom_object_report_share, public.custom_object_report_share_grant TO service_role;

ALTER TABLE public.custom_object_report_sort_job ADD COLUMN IF NOT EXISTS requested_by_report_grant_id uuid;
DO $$
DECLARE old_constraint text;
BEGIN
  FOR old_constraint IN SELECT conname FROM pg_constraint
    WHERE conrelid='public.custom_object_report_sort_job'::regclass
      AND contype='c' AND pg_get_constraintdef(oid) LIKE '%num_nonnulls%'
  LOOP
    EXECUTE format('ALTER TABLE public.custom_object_report_sort_job DROP CONSTRAINT %I',old_constraint);
  END LOOP;
  ALTER TABLE public.custom_object_report_sort_job ADD CONSTRAINT custom_object_report_sort_owner
    CHECK (num_nonnulls(requested_by_member_id,requested_by_tenant_user_id,requested_by_report_grant_id)=1);
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.custom_object_report_sort_job'::regclass
    AND conname='custom_object_report_sort_grant_fk') THEN
    ALTER TABLE public.custom_object_report_sort_job ADD CONSTRAINT custom_object_report_sort_grant_fk
      FOREIGN KEY(tenant_id,requested_by_report_grant_id)
      REFERENCES public.custom_object_report_share_grant(tenant_id,id);
  END IF;
END;
$$;
CREATE INDEX IF NOT EXISTS custom_object_report_sort_grant_owner ON public.custom_object_report_sort_job(tenant_id,requested_by_report_grant_id);

-- Unsorted external reports still use bounded immutable pages. Keep the
-- renderer's original occurrence order, rather than sorting page by page or
-- giving anonymous users the legacy synchronous export path.
CREATE OR REPLACE FUNCTION public.custom_object_report_share_commit(
  p_tenant_id uuid,p_object_id uuid,p_job_id uuid,p_claim_token uuid,
  p_page integer,p_rows jsonb,p_headers jsonb,p_next_cursor text,p_has_more boolean
) RETURNS jsonb LANGUAGE plpgsql SET search_path=public AS $$
DECLARE
  j public.custom_object_report_sort_job%ROWTYPE;
  item jsonb;
  inserted_count integer;
BEGIN
  SELECT * INTO j FROM public.custom_object_report_sort_job
    WHERE tenant_id=p_tenant_id AND custom_object_id=p_object_id AND id=p_job_id FOR UPDATE;
  IF NOT FOUND OR j.requested_by_report_grant_id IS NULL OR j.claim_token IS DISTINCT FROM p_claim_token
    OR p_claim_token IS NULL OR j.next_page IS DISTINCT FROM p_page OR j.status<>'processing'
    OR j.expires_at<=now() THEN
    RAISE EXCEPTION 'Report claim expired' USING ERRCODE='P0001';
  END IF;
  IF jsonb_array_length(j.sort_rules)>0 THEN
    RETURN public.custom_object_report_sort_commit(p_tenant_id,p_object_id,p_job_id,p_claim_token,
      p_page,p_rows,p_headers,p_next_cursor,p_has_more);
  END IF;
  IF jsonb_typeof(p_rows) IS DISTINCT FROM 'array' OR jsonb_array_length(p_rows)>j.chunk_size
    OR jsonb_typeof(p_headers) IS DISTINCT FROM 'array' OR p_has_more IS NULL
    OR (p_has_more AND (p_next_cursor IS NULL OR p_next_cursor IS NOT DISTINCT FROM j.cursor_value))
    OR (j.next_page>1 AND j.headers IS DISTINCT FROM p_headers) THEN
    RAISE EXCEPTION 'Invalid report page' USING ERRCODE='22023';
  END IF;
  FOR item IN SELECT value FROM jsonb_array_elements(p_rows) LOOP
    IF NULLIF(item->>'id','') IS NULL OR jsonb_typeof(item->'values') IS DISTINCT FROM 'array'
      OR jsonb_typeof(item->'sort_values') IS DISTINCT FROM 'array'
      OR jsonb_array_length(item->'values')<>jsonb_array_length(p_headers)
      OR jsonb_array_length(item->'sort_values')<>jsonb_array_length(p_headers) THEN
      RAISE EXCEPTION 'Invalid report row' USING ERRCODE='22023';
    END IF;
  END LOOP;
  INSERT INTO public.custom_object_report_sort_row(tenant_id,job_id,row_identity,row_values,sort_values,position)
    SELECT p_tenant_id,p_job_id,value->>'id',value->'values',value->'sort_values',j.processed+ordinality
      FROM jsonb_array_elements(p_rows) WITH ORDINALITY;
  GET DIAGNOSTICS inserted_count=ROW_COUNT;
  UPDATE public.custom_object_report_sort_job SET
    headers=p_headers, processed=processed+inserted_count,total=processed+inserted_count,
    next_page=next_page+1,cursor_value=p_next_cursor,claim_token=NULL,
    status=CASE WHEN p_has_more THEN 'processing' ELSE 'ready' END,updated_at=now()
    WHERE tenant_id=p_tenant_id AND id=p_job_id RETURNING * INTO j;
  RETURN to_jsonb(j);
END;
$$;
REVOKE ALL ON FUNCTION public.custom_object_report_share_commit(uuid,uuid,uuid,uuid,integer,jsonb,jsonb,text,boolean)
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.custom_object_report_share_commit(uuid,uuid,uuid,uuid,integer,jsonb,jsonb,text,boolean) TO service_role;

-- Only remove a bounded number of old grants with no remaining snapshot.
CREATE OR REPLACE FUNCTION public.custom_object_report_share_prune(p_tenant_id uuid)
RETURNS void LANGUAGE sql SET search_path=public AS $$
  DELETE FROM public.custom_object_report_share_grant g USING (
    SELECT g.id FROM public.custom_object_report_share_grant g WHERE g.tenant_id=p_tenant_id AND g.expires_at<now()
    AND NOT EXISTS(SELECT 1 FROM public.custom_object_report_sort_job j
      WHERE j.tenant_id=g.tenant_id AND j.requested_by_report_grant_id=g.id)
    LIMIT 100 FOR UPDATE OF g SKIP LOCKED
  ) expired WHERE g.tenant_id=p_tenant_id AND g.id=expired.id;
$$;
REVOKE ALL ON FUNCTION public.custom_object_report_share_prune(uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.custom_object_report_share_prune(uuid) TO service_role;
NOTIFY pgrst,'reload schema';
COMMIT;
