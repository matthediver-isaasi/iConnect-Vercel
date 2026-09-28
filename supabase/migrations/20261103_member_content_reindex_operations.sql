-- Dedicated, service-only operation state for the Member Content reindexer.
-- Do not use system_settings for worker ownership: that broad shared table has
-- browser-facing mutation paths and is not an authority boundary for a costly
-- embedding worker.

CREATE TABLE IF NOT EXISTS public.member_content_reindex_operation (
  operation_key text PRIMARY KEY,
  run_id uuid,
  scope jsonb NOT NULL DEFAULT '{}'::jsonb,
  started_at timestamptz,
  heartbeat_at timestamptz,
  last_completed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT member_content_reindex_operation_key_check
    CHECK (operation_key = 'global')
);

ALTER TABLE public.member_content_reindex_operation ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.member_content_reindex_operation FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.member_content_reindex_operation
  FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.member_content_reindex_operation TO service_role;

DROP POLICY IF EXISTS member_content_reindex_operation_service_role_only
  ON public.member_content_reindex_operation;
CREATE POLICY member_content_reindex_operation_service_role_only
  ON public.member_content_reindex_operation
  AS PERMISSIVE
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- An advisory transaction lock serializes first-row creation as well as normal
-- takeovers.  This makes claim/reclaim atomic even through a transaction pooler.
CREATE OR REPLACE FUNCTION public.claim_member_content_reindex_operation(
  p_run_id uuid,
  p_scope jsonb DEFAULT '{}'::jsonb,
  p_stale_seconds integer DEFAULT 300
) RETURNS TABLE (
  acquired boolean,
  active_run_id uuid,
  heartbeat_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  current_row public.member_content_reindex_operation%ROWTYPE;
BEGIN
  IF p_run_id IS NULL OR p_stale_seconds < 30 OR p_stale_seconds > 3600 THEN
    RAISE EXCEPTION 'invalid reindex operation claim';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('member-content-reindex-operation', 61103));
  SELECT * INTO current_row
  FROM public.member_content_reindex_operation
  WHERE operation_key = 'global'
  FOR UPDATE;

  IF NOT FOUND OR current_row.run_id IS NULL
     OR current_row.heartbeat_at IS NULL
     OR current_row.heartbeat_at < now() - make_interval(secs => p_stale_seconds) THEN
    INSERT INTO public.member_content_reindex_operation (
      operation_key, run_id, scope, started_at, heartbeat_at, updated_at
    ) VALUES ('global', p_run_id, COALESCE(p_scope, '{}'::jsonb), now(), now(), now())
    ON CONFLICT (operation_key) DO UPDATE
    SET run_id = EXCLUDED.run_id,
        scope = EXCLUDED.scope,
        started_at = now(),
        heartbeat_at = now(),
        updated_at = now();
    RETURN QUERY SELECT true, p_run_id, now();
  ELSE
    RETURN QUERY SELECT false, current_row.run_id, current_row.heartbeat_at;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.renew_member_content_reindex_operation(
  p_run_id uuid,
  p_scope jsonb DEFAULT '{}'::jsonb
) RETURNS TABLE (
  owns boolean,
  active_run_id uuid
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  current_row public.member_content_reindex_operation%ROWTYPE;
BEGIN
  IF p_run_id IS NULL THEN
    RETURN QUERY SELECT false, NULL::uuid;
    RETURN;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('member-content-reindex-operation', 61103));
  SELECT * INTO current_row
  FROM public.member_content_reindex_operation
  WHERE operation_key = 'global'
  FOR UPDATE;
  IF FOUND AND current_row.run_id = p_run_id THEN
    UPDATE public.member_content_reindex_operation
    SET scope = COALESCE(p_scope, scope),
        heartbeat_at = now(),
        updated_at = now()
    WHERE operation_key = 'global';
    RETURN QUERY SELECT true, p_run_id;
  ELSE
    RETURN QUERY SELECT false, current_row.run_id;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.complete_member_content_reindex_operation(
  p_run_id uuid,
  p_completed boolean DEFAULT false
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  current_row public.member_content_reindex_operation%ROWTYPE;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('member-content-reindex-operation', 61103));
  SELECT * INTO current_row
  FROM public.member_content_reindex_operation
  WHERE operation_key = 'global'
  FOR UPDATE;
  IF NOT FOUND OR current_row.run_id IS NULL OR p_run_id IS NULL
     OR current_row.run_id = p_run_id THEN
    INSERT INTO public.member_content_reindex_operation (
      operation_key, run_id, scope, started_at, heartbeat_at, last_completed_at, updated_at
    ) VALUES (
      'global', NULL, '{}'::jsonb, NULL, NULL,
      CASE WHEN p_completed THEN now() ELSE NULL END, now()
    )
    ON CONFLICT (operation_key) DO UPDATE
    SET run_id = NULL,
        scope = '{}'::jsonb,
        started_at = NULL,
        heartbeat_at = NULL,
        last_completed_at = CASE
          WHEN p_completed THEN now()
          ELSE public.member_content_reindex_operation.last_completed_at
        END,
        updated_at = now();
    RETURN true;
  END IF;
  RETURN false;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_member_content_reindex_operation(uuid, jsonb, integer)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.renew_member_content_reindex_operation(uuid, jsonb)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.complete_member_content_reindex_operation(uuid, boolean)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_member_content_reindex_operation(uuid, jsonb, integer)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.renew_member_content_reindex_operation(uuid, jsonb)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.complete_member_content_reindex_operation(uuid, boolean)
  TO service_role;