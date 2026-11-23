BEGIN;
CREATE FUNCTION public.event_funnel_maintenance()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE expired_count integer; answers_count integer; holds_count integer; sessions_count integer;
BEGIN
  WITH targets AS (
    SELECT s.id FROM public.event_funnel_session s WHERE s.state='held' AND s.expires_at<=clock_timestamp()
      AND NOT EXISTS(SELECT 1 FROM public.event_funnel_order o WHERE o.tenant_id=s.tenant_id AND o.session_id=s.id
        AND o.state NOT IN ('cancelled','failed'))
      ORDER BY s.expires_at,s.id LIMIT 100 FOR UPDATE OF s SKIP LOCKED
  ), changed AS (
    UPDATE public.event_funnel_session SET state='expired',revision=revision+1,updated_at=clock_timestamp()
      WHERE id IN (SELECT id FROM targets) RETURNING id
  ) SELECT count(*) INTO expired_count FROM changed;
  -- Keep entered details through the promised retention date. Never remove
  -- uncertain/paid authority, even when a provider outage lasts beyond that date.
  WITH targets AS (
    SELECT s.id FROM public.event_funnel_session s WHERE s.retain_until<clock_timestamp()
      AND s.state IN ('draft','expired','cancelled')
      AND (EXISTS(SELECT 1 FROM public.event_funnel_draft d WHERE d.session_id=s.id AND d.tenant_id=s.tenant_id)
        OR EXISTS(SELECT 1 FROM public.event_funnel_hold h WHERE h.session_id=s.id AND h.tenant_id=s.tenant_id))
      AND NOT EXISTS(SELECT 1 FROM public.event_funnel_order o WHERE o.tenant_id=s.tenant_id AND o.session_id=s.id
        AND o.state NOT IN ('cancelled','failed'))
      ORDER BY s.retain_until,s.id LIMIT 100 FOR UPDATE OF s SKIP LOCKED
  ), deleted_answers AS (
    DELETE FROM public.event_funnel_draft WHERE session_id IN (SELECT id FROM targets) RETURNING session_id
  ), deleted_holds AS (
    DELETE FROM public.event_funnel_hold WHERE session_id IN (SELECT id FROM targets) RETURNING session_id
  ) SELECT (SELECT count(*) FROM deleted_answers),(SELECT count(*) FROM deleted_holds)
    INTO answers_count,holds_count;
  -- Cancelled orders retain their owning session as financial evidence.
  WITH targets AS (
    SELECT s.id FROM public.event_funnel_session s WHERE s.retain_until<clock_timestamp()
      AND s.state IN ('draft','expired','cancelled')
      AND NOT EXISTS(SELECT 1 FROM public.event_funnel_order o WHERE o.session_id=s.id AND o.tenant_id=s.tenant_id)
      ORDER BY s.retain_until,s.id LIMIT 100 FOR UPDATE OF s SKIP LOCKED
  ), deleted AS (
    DELETE FROM public.event_funnel_session WHERE id IN (SELECT id FROM targets) RETURNING id
  ) SELECT count(*) INTO sessions_count FROM deleted;
  IF to_regprocedure('public.event_funnel_prune_legacy_intents()') IS NOT NULL THEN
    PERFORM public.event_funnel_prune_legacy_intents();
  END IF;
  RETURN jsonb_build_object('expired',expired_count,'answersRemoved',answers_count,'holdsRemoved',holds_count,'sessionsRemoved',sessions_count);
END $$;
CREATE OR REPLACE FUNCTION public.event_funnel_purge_drafts()
RETURNS integer LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
  SELECT (public.event_funnel_maintenance()->>'sessionsRemoved')::integer
$$;
REVOKE ALL ON FUNCTION public.event_funnel_maintenance() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.event_funnel_maintenance() TO service_role;
COMMIT;
