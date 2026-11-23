BEGIN;
CREATE FUNCTION public.event_funnel_standalone_offer_allowed(p_tenant uuid,p_kind text,p_event uuid,p_tickets jsonb)
RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
  IF p_tenant IS NULL OR p_event IS NULL OR p_kind IS NULL OR p_kind NOT IN ('simple','complex')
    OR jsonb_typeof(p_tickets) IS DISTINCT FROM 'array' OR jsonb_array_length(p_tickets)>100
    OR EXISTS(SELECT 1 FROM jsonb_array_elements(p_tickets) t WHERE jsonb_typeof(t)<>'string'
      OR length(t#>>'{}') NOT BETWEEN 1 AND 160) THEN
    RAISE EXCEPTION 'Invalid event offer check' USING ERRCODE='22023';
  END IF;
  RETURN NOT EXISTS(
    SELECT 1 FROM public.event_funnel_offer_policy p
      JOIN public.event_funnel_entry x ON x.tenant_id=p.tenant_id AND x.version_id=p.version_id
      WHERE p.tenant_id=p_tenant AND p.event_kind=p_kind AND p.event_id=p_event AND p.funnel_only
        AND (jsonb_array_length(p_tickets)=0
          OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(p_tickets) ticket WHERE p.ticket_ids ? ticket))
  );
END $$;
REVOKE ALL ON FUNCTION public.event_funnel_standalone_offer_allowed(uuid,text,uuid,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.event_funnel_standalone_offer_allowed(uuid,text,uuid,jsonb) TO service_role;
-- Existing contracts retain their original authority. New legacy contracts
-- serialize with publication before becoming payable, not after card capture.
CREATE FUNCTION public.event_funnel_legacy_contract_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE kind text; tickets jsonb; prior jsonb; incoming jsonb;
BEGIN
  IF TG_TABLE_NAME='unified_booking_contract' THEN
    kind:=CASE NEW.source WHEN 'booking' THEN 'simple' WHEN 'complex_event_booking' THEN 'complex' END;
    tickets:=coalesce(NEW.snapshot#>'{request,ticketIds}','[]'::jsonb);
  ELSIF TG_TABLE_NAME='event_invoice_address_policy' THEN
    kind:=NEW.source;
    IF kind='simple' THEN
      tickets:=jsonb_build_array(coalesce(NEW.snapshot#>>'{request,charge,metadata,ticket_class_id}','default'));
    ELSE
      SELECT coalesce(jsonb_agg(value->>'ticket_class_id'),'[]'::jsonb) INTO tickets
        FROM jsonb_array_elements(NEW.snapshot#>'{request,charge,items}');
    END IF;
  ELSIF TG_TABLE_NAME='public_ticket_member_purchase' THEN
    kind:=NEW.event_kind;
    SELECT coalesce(jsonb_agg(value->>'ticket_id'),'[]'::jsonb) INTO tickets
      FROM jsonb_array_elements(NEW.snapshot->'ticket_policies');
  ELSE
    RAISE EXCEPTION 'Unknown purchase authority table' USING ERRCODE='22023';
  END IF;
  IF kind IS NULL THEN RAISE EXCEPTION 'Unknown event purchase source' USING ERRCODE='22023'; END IF;
  PERFORM public.event_funnel_lock_event(NEW.tenant_id,kind,NEW.event_id);
  -- Some established preparation RPCs INSERT ... ON CONFLICT DO NOTHING
  -- before reading their saved snapshot. BEFORE INSERT also runs on that
  -- replay; permit only an exact immutable binding, never a new row/grant.
  incoming:=to_jsonb(NEW);
  EXECUTE format('SELECT to_jsonb(p) FROM public.%I p WHERE id=$1',TG_TABLE_NAME) INTO prior USING NEW.id;
  IF prior IS NOT NULL AND prior->'tenant_id'=incoming->'tenant_id'
    AND prior->'event_id'=incoming->'event_id'
    AND prior->'source' IS NOT DISTINCT FROM incoming->'source'
    AND prior->'event_kind' IS NOT DISTINCT FROM incoming->'event_kind'
    AND prior->'member_id' IS NOT DISTINCT FROM incoming->'member_id'
    AND prior->'snapshot'=incoming->'snapshot' THEN RETURN NEW; END IF;
  IF NOT public.event_funnel_standalone_offer_allowed(NEW.tenant_id,kind,NEW.event_id,tickets) THEN
    RAISE EXCEPTION 'This ticket requires its source registration in the same checkout' USING ERRCODE='PT403';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER event_funnel_legacy_contract_guard BEFORE INSERT ON public.unified_booking_contract
  FOR EACH ROW EXECUTE FUNCTION public.event_funnel_legacy_contract_guard();
CREATE TRIGGER event_funnel_legacy_invoice_policy_guard BEFORE INSERT ON public.event_invoice_address_policy
  FOR EACH ROW EXECUTE FUNCTION public.event_funnel_legacy_contract_guard();
CREATE TRIGGER event_funnel_legacy_public_purchase_guard BEFORE INSERT ON public.public_ticket_member_purchase
  FOR EACH ROW EXECUTE FUNCTION public.event_funnel_legacy_contract_guard();
REVOKE ALL ON FUNCTION public.event_funnel_legacy_contract_guard() FROM PUBLIC,anon,authenticated,service_role;
NOTIFY pgrst,'reload schema';
COMMIT;
