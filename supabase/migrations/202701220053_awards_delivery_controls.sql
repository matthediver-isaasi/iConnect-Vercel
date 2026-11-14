BEGIN;
CREATE FUNCTION public.awards_delivery_control(p_tenant uuid,p_award uuid,p_delivery uuid,p_command text,
  p_version text DEFAULT NULL,p_actor_kind text DEFAULT NULL,p_actor uuid DEFAULT NULL,p_reason text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE d public.awards_delivery; version text; can_retry boolean; can_cancel boolean;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'Service authority required' USING ERRCODE='42501'; END IF;
  IF p_command NOT IN ('read','retry','cancel') THEN RAISE EXCEPTION 'Unknown delivery action'; END IF;
  PERFORM 1 FROM public.awards_competition WHERE tenant_id=p_tenant AND id=p_award FOR UPDATE;
  SELECT * INTO d FROM public.awards_delivery WHERE tenant_id=p_tenant AND award_id=p_award AND id=p_delivery FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Delivery unavailable' USING ERRCODE='P0002'; END IF;
  version:=md5(to_jsonb(d)::text);
  can_retry:=d.state IN ('retry','attention') AND d.sending_started_at IS NULL;
  can_cancel:=d.state IN ('pending','retry','attention');
  IF p_command='read' THEN RETURN jsonb_build_object('id',d.id,'state',d.state,'version',version,
    'canRetry',can_retry,'canCancel',can_cancel,'providerOutcomeUncertain',
      coalesce(d.state='attention' OR d.last_error_code='ADMIN_CANCELLED_UNCERTAIN',false) AND d.sending_started_at IS NOT NULL);
  END IF;
  IF p_version IS DISTINCT FROM version THEN RAISE EXCEPTION 'Delivery changed; review its current status' USING ERRCODE='40001'; END IF;
  IF p_actor_kind NOT IN ('member','tenant_user') OR p_actor IS NULL OR length(btrim(coalesce(p_reason,'')))=0 OR length(p_reason)>2000 THEN
    RAISE EXCEPTION 'Delivery authority and reason required'; END IF;
  IF p_command='retry' THEN
    IF NOT can_retry THEN RAISE EXCEPTION 'Only definitely unsent deliveries can be retried; uncertain provider outcomes must not be replayed'; END IF;
    IF NOT public.awards_message_authority(p_tenant,p_award,d.category,d.recipient_context,d.release_id) THEN
      RAISE EXCEPTION 'Recipient or release is no longer eligible'; END IF;
    UPDATE public.awards_delivery SET state='retry',due_at=clock_timestamp(),claim_token=NULL,lease_until=NULL,last_error_code=NULL WHERE id=d.id;
  ELSE
    IF NOT can_cancel THEN RAISE EXCEPTION 'An active or delivered send cannot be cancelled'; END IF;
    UPDATE public.awards_delivery SET state='cancelled',claim_token=NULL,lease_until=NULL,
      last_error_code=CASE WHEN sending_started_at IS NOT NULL THEN 'ADMIN_CANCELLED_UNCERTAIN' ELSE 'ADMIN_CANCELLED' END WHERE id=d.id;
  END IF;
  INSERT INTO public.awards_audit_event(tenant_id,award_id,actor_kind,actor_id,action,subject_id,reason,changes)
    VALUES(p_tenant,p_award,p_actor_kind,p_actor,'message.'||p_command,d.id,p_reason,
      jsonb_build_object('previous_state',d.state,'provider_outcome_uncertain',d.sending_started_at IS NOT NULL,'attempts',d.attempts));
  RETURN jsonb_build_object('id',d.id,'state',CASE WHEN p_command='retry' THEN 'retry' ELSE 'cancelled' END,'sent',false);
END $$;
REVOKE ALL ON FUNCTION public.awards_delivery_control(uuid,uuid,uuid,text,text,text,uuid,text) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.awards_delivery_control(uuid,uuid,uuid,text,text,text,uuid,text) TO service_role;
COMMIT;
