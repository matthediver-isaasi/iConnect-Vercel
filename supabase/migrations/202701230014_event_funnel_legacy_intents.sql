BEGIN;
-- Access evidence only, not proof of payment or permission to insert bookings.
-- Pure legacy Stripe requests previously had no durable pre-provider record.
CREATE TABLE public.event_funnel_legacy_intent (
  tenant_id uuid NOT NULL,id uuid NOT NULL,event_kind text NOT NULL CHECK(event_kind IN ('simple','complex')),
  event_id uuid NOT NULL,ticket_ids jsonb NOT NULL,provider_request jsonb NOT NULL,
  request_hash text NOT NULL,payment_intent_id text,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  bound_at timestamptz,PRIMARY KEY(tenant_id,id),UNIQUE(tenant_id,payment_intent_id)
);
ALTER TABLE public.event_funnel_legacy_intent ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.event_funnel_legacy_intent FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.event_funnel_legacy_intent TO service_role;
CREATE POLICY event_funnel_legacy_intent_service_read ON public.event_funnel_legacy_intent
  FOR SELECT TO service_role USING(true);
CREATE FUNCTION public.event_funnel_prepare_legacy_intent(p_tenant uuid,p_id uuid,p_kind text,
  p_event uuid,p_tickets jsonb,p_parameters jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE prior public.event_funnel_legacy_intent; request jsonb; fingerprint text;
BEGIN
  IF p_id IS NULL OR jsonb_typeof(p_parameters) IS DISTINCT FROM 'object'
    OR jsonb_typeof(p_parameters->'metadata') IS DISTINCT FROM 'object'
    OR jsonb_typeof(p_parameters->'amount') IS DISTINCT FROM 'number'
    OR octet_length(p_parameters::text)>64000 OR p_parameters ? 'confirm'
    OR coalesce(p_parameters->>'currency','') !~ '^[a-z]{3}$'
    OR coalesce(p_parameters->>'amount','') !~ '^[1-9][0-9]*$'
    OR (p_parameters->>'amount')::numeric>9007199254740991 THEN
    RAISE EXCEPTION 'Invalid legacy payment request' USING ERRCODE='22023';
  END IF;
  IF nullif(p_parameters#>>'{metadata,tenant_id}','')::uuid IS DISTINCT FROM p_tenant
    OR nullif(p_parameters#>>'{metadata,event_id}','')::uuid IS DISTINCT FROM p_event THEN
    RAISE EXCEPTION 'Payment metadata does not match event authority' USING ERRCODE='22023';
  END IF;
  PERFORM public.event_funnel_lock_event(p_tenant,p_kind,p_event);
  IF p_kind='simple' AND NOT EXISTS(SELECT 1 FROM event WHERE tenant_id=p_tenant AND id=p_event)
    OR p_kind='complex' AND NOT EXISTS(SELECT 1 FROM complex_event WHERE tenant_id=p_tenant AND id=p_event) THEN
    RAISE EXCEPTION 'Event not found' USING ERRCODE='PT404';
  END IF;
  request:=jsonb_set(p_parameters,'{metadata,event_funnel_legacy_authority_id}',to_jsonb(p_id::text),true);
  fingerprint:=encode(sha256(convert_to(request::text,'UTF8')),'hex');
  SELECT * INTO prior FROM event_funnel_legacy_intent WHERE tenant_id=p_tenant AND id=p_id FOR UPDATE;
  IF FOUND THEN
    IF prior.event_kind IS DISTINCT FROM p_kind OR prior.event_id IS DISTINCT FROM p_event
      OR prior.ticket_ids IS DISTINCT FROM p_tickets OR prior.request_hash<>fingerprint THEN
      RAISE EXCEPTION 'Original payment request changed' USING ERRCODE='PT409';
    END IF;
    RETURN to_jsonb(prior);
  END IF;
  IF NOT public.event_funnel_standalone_offer_allowed(p_tenant,p_kind,p_event,p_tickets) THEN
    RAISE EXCEPTION 'This ticket requires its source registration in the same checkout' USING ERRCODE='PT403';
  END IF;
  INSERT INTO event_funnel_legacy_intent(tenant_id,id,event_kind,event_id,ticket_ids,provider_request,request_hash)
    VALUES(p_tenant,p_id,p_kind,p_event,p_tickets,request,fingerprint) RETURNING * INTO prior;
  RETURN to_jsonb(prior);
END $$;
CREATE FUNCTION public.event_funnel_bind_legacy_intent(p_tenant uuid,p_id uuid,p_hash text,p_intent text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE prior public.event_funnel_legacy_intent;
BEGIN
  SELECT * INTO STRICT prior FROM event_funnel_legacy_intent WHERE tenant_id=p_tenant AND id=p_id FOR UPDATE;
  IF p_hash IS DISTINCT FROM prior.request_hash OR p_intent IS NULL OR p_intent !~ '^pi_[A-Za-z0-9_]{1,180}$'
    OR prior.payment_intent_id IS NOT NULL AND prior.payment_intent_id<>p_intent THEN
    RAISE EXCEPTION 'Original payment binding changed' USING ERRCODE='PT409';
  END IF;
  UPDATE event_funnel_legacy_intent SET payment_intent_id=p_intent,bound_at=coalesce(bound_at,clock_timestamp())
    WHERE tenant_id=p_tenant AND id=p_id;
  RETURN true;
END $$;
CREATE FUNCTION public.event_funnel_prune_legacy_intents()
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE removed integer;
BEGIN
  WITH expired AS (SELECT tenant_id,id FROM event_funnel_legacy_intent
    WHERE payment_intent_id IS NULL AND created_at<clock_timestamp()-interval '30 days'
    ORDER BY created_at LIMIT 100 FOR UPDATE SKIP LOCKED)
  DELETE FROM event_funnel_legacy_intent a USING expired e WHERE a.tenant_id=e.tenant_id AND a.id=e.id;
  GET DIAGNOSTICS removed=ROW_COUNT; RETURN removed;
END $$;
REVOKE ALL ON FUNCTION public.event_funnel_prepare_legacy_intent(uuid,uuid,text,uuid,jsonb,jsonb),
  public.event_funnel_bind_legacy_intent(uuid,uuid,text,text),public.event_funnel_prune_legacy_intents()
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.event_funnel_prepare_legacy_intent(uuid,uuid,text,uuid,jsonb,jsonb),
  public.event_funnel_bind_legacy_intent(uuid,uuid,text,text),public.event_funnel_prune_legacy_intents()
  TO service_role;
NOTIFY pgrst,'reload schema';
COMMIT;
