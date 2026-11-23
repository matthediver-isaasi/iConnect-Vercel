BEGIN;
ALTER TABLE public.event_funnel_confirmation ADD COLUMN redacted_at timestamptz;
CREATE INDEX event_funnel_confirmation_retention_due ON public.event_funnel_confirmation(order_id,tenant_id,id)
  WHERE state='delivered' AND delivered_at IS NOT NULL AND redacted_at IS NULL;

-- Retain delivery identity and provider acknowledgement, not message bodies,
-- recipient snapshots or attachments beyond the original session's retention
-- deadline. Uncertain and unfinished sends remain recovery evidence.
CREATE FUNCTION public.event_funnel_confirmation_prune(p_limit integer DEFAULT 100)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE changed integer;
BEGIN
  IF p_limit IS NULL OR p_limit<1 OR p_limit>500 THEN
    RAISE EXCEPTION 'Invalid retention batch size' USING ERRCODE='22023';
  END IF;
  WITH candidates AS (
    SELECT c.id FROM public.event_funnel_confirmation c
    JOIN public.event_funnel_order o ON o.tenant_id=c.tenant_id AND o.id=c.order_id
    JOIN public.event_funnel_session s ON s.tenant_id=o.tenant_id AND s.id=o.session_id
    WHERE c.state='delivered' AND c.delivered_at IS NOT NULL AND c.redacted_at IS NULL
      AND s.retain_until<=clock_timestamp()
    ORDER BY s.retain_until,c.id LIMIT p_limit FOR UPDATE OF c SKIP LOCKED
  )
  UPDATE public.event_funnel_confirmation c SET booking='{}'::jsonb,template='{}'::jsonb,
    payload=NULL,attempt_token=NULL,redacted_at=clock_timestamp()
    FROM candidates x WHERE c.id=x.id;
  GET DIAGNOSTICS changed=ROW_COUNT;
  RETURN changed;
END $$;
REVOKE ALL ON FUNCTION public.event_funnel_confirmation_prune(integer) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.event_funnel_confirmation_prune(integer) TO service_role;
COMMIT;
