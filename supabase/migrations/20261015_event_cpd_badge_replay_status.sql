-- Aggregate status for the latest event-scoped historical badge replay.
-- The service-only function intentionally returns no booking or attendee data.
CREATE INDEX IF NOT EXISTS idx_event_cpd_badge_outbox_replay_status
  ON public.event_cpd_badge_outbox(tenant_id,idempotency_key text_pattern_ops);

CREATE OR REPLACE FUNCTION public.get_latest_event_cpd_badge_replay_status(
  p_tenant_id uuid,p_event_type text,p_event_id uuid
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_replay public.event_cpd_badge_replay%ROWTYPE; v_status jsonb;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'service_role is required';
  END IF;
  IF p_tenant_id IS NULL OR p_event_type NOT IN ('event','complex_event') OR p_event_id IS NULL THEN
    RAISE EXCEPTION 'complete replay scope is required';
  END IF;

  SELECT * INTO v_replay
  FROM event_cpd_badge_replay
  WHERE tenant_id=p_tenant_id AND event_type=p_event_type AND event_id=p_event_id
  ORDER BY created_at DESC,id DESC
  LIMIT 1;
  IF NOT FOUND THEN RETURN NULL; END IF;

  SELECT jsonb_build_object(
    'replay_id',v_replay.id,
    'created_at',v_replay.created_at,
    'enqueued_count',v_replay.enqueued_count,
    'pending',count(*) FILTER (WHERE status IN ('pending','processing')),
    'completed',count(*) FILTER (WHERE status='complete'),
    'retrying',count(*) FILTER (WHERE status='retry'),
    'permanently_failed',count(*) FILTER (WHERE status='dead')
  ) INTO v_status
  FROM event_cpd_badge_outbox
  WHERE tenant_id=p_tenant_id
    AND idempotency_key LIKE 'badge-replay:'||v_replay.id::text||':%';
  RETURN v_status;
END $$;

REVOKE ALL ON FUNCTION public.get_latest_event_cpd_badge_replay_status(uuid,text,uuid)
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.get_latest_event_cpd_badge_replay_status(uuid,text,uuid)
  TO service_role;