BEGIN;
CREATE TABLE public.event_funnel_voucher_reservation (
  tenant_id uuid NOT NULL,
  order_id uuid NOT NULL,
  voucher_id uuid NOT NULL REFERENCES public.voucher(id),
  purchase_id uuid NOT NULL REFERENCES public.voucher_credit_purchase(id),
  purchase_key text NOT NULL,
  amount_minor bigint NOT NULL CHECK(amount_minor>0),
  state text NOT NULL DEFAULT 'held' CHECK(state IN ('held','committed','released')),
  PRIMARY KEY(tenant_id,order_id,voucher_id),
  UNIQUE(tenant_id,purchase_key),
  FOREIGN KEY(tenant_id,order_id) REFERENCES public.event_funnel_order(tenant_id,id)
);
ALTER TABLE public.event_funnel_voucher_reservation ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.event_funnel_voucher_reservation FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION public.event_funnel_voucher_reserve()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE allocations jsonb; allocation jsonb; part jsonb; h public.event_funnel_hold; v public.voucher;
  purchaser uuid; key text; reserved jsonb; allocated bigint; total bigint:=0; start_at timestamptz; event_data jsonb;
  expected bigint:=coalesce((NEW.snapshot->>'voucherMinor')::bigint,0); allow_after boolean;
BEGIN
  IF expected<0 THEN RAISE EXCEPTION 'Invalid voucher funding' USING ERRCODE='22023'; END IF;
  IF expected=0 THEN RETURN NEW; END IF;
  SELECT member_id INTO purchaser FROM public.event_funnel_session WHERE tenant_id=NEW.tenant_id AND id=NEW.session_id;
  IF purchaser IS NULL THEN RAISE EXCEPTION 'Vouchers require the original signed-in purchaser' USING ERRCODE='42501'; END IF;
  IF EXISTS(SELECT 1 FROM public.system_settings WHERE tenant_id=NEW.tenant_id AND setting_key='event_allow_voucher_payment'
    AND lower(trim(setting_value))='false') THEN RAISE EXCEPTION 'Voucher payment is disabled' USING ERRCODE='42501'; END IF;
  allocations:=NEW.snapshot->'voucherAllocations';
  IF jsonb_typeof(allocations) IS DISTINCT FROM 'array' OR jsonb_array_length(allocations)>100
    OR (SELECT count(DISTINCT value->>'voucherId') FROM jsonb_array_elements(allocations))<>jsonb_array_length(allocations) THEN
    RAISE EXCEPTION 'Invalid voucher allocation evidence' USING ERRCODE='22023';
  END IF;
  -- Match ordinary voucher writers' deterministic lock order before making
  -- separate, amount-capped reservations for each selected voucher.
  PERFORM 1 FROM public.voucher WHERE tenant_id=NEW.tenant_id
    AND id IN (SELECT (value->>'voucherId')::uuid FROM jsonb_array_elements(allocations)) ORDER BY id FOR UPDATE;
  allow_after:=NOT EXISTS(SELECT 1 FROM public.system_settings WHERE tenant_id=NEW.tenant_id
    AND setting_key='allow_voucher_use_after_expiry' AND setting_value='false');
  FOR allocation IN SELECT value FROM jsonb_array_elements(allocations) LOOP
    IF (allocation->>'amountMinor')::bigint=0 THEN CONTINUE; END IF;
    IF (allocation->>'amountMinor')::bigint IS NULL OR (allocation->>'amountMinor')::bigint<0
      OR jsonb_typeof(allocation->'lines') IS DISTINCT FROM 'array'
      OR (SELECT count(DISTINCT (value->>'nodeId',value->>'ticketId')) FROM jsonb_array_elements(allocation->'lines'))
        <>jsonb_array_length(allocation->'lines') THEN
      RAISE EXCEPTION 'Invalid voucher line allocation' USING ERRCODE='22023';
    END IF;
    SELECT * INTO v FROM public.voucher WHERE tenant_id=NEW.tenant_id AND id=(allocation->>'voucherId')::uuid;
    IF NOT FOUND OR to_jsonb(v)->>'funding_source'='membership_change' THEN
      RAISE EXCEPTION 'Voucher is unavailable for event purchases' USING ERRCODE='42501';
    END IF;
    allocated:=0;
    FOR part IN SELECT value FROM jsonb_array_elements(allocation->'lines') LOOP
      SELECT * INTO h FROM public.event_funnel_hold WHERE tenant_id=NEW.tenant_id AND session_id=NEW.session_id
        AND node_id=part->>'nodeId' AND ticket_id=part->>'ticketId';
      IF NOT FOUND OR (part->>'amountMinor')::bigint IS NULL OR (part->>'amountMinor')::bigint<=0 THEN
        RAISE EXCEPTION 'Voucher destination is not held' USING ERRCODE='22023';
      END IF;
      IF h.event_kind='simple' THEN
        SELECT to_jsonb(e) INTO event_data FROM public.event e WHERE tenant_id=NEW.tenant_id AND id=h.event_id;
      ELSE
        SELECT to_jsonb(e) INTO event_data FROM public.complex_event e WHERE tenant_id=NEW.tenant_id AND id=h.event_id;
      END IF;
      IF event_data IS NULL THEN RAISE EXCEPTION 'Voucher event unavailable' USING ERRCODE='PT409'; END IF;
      start_at:=nullif(event_data->>'start_date','')::timestamptz;
      IF h.event_kind='complex' AND start_at IS NULL THEN
        SELECT min(start_time) INTO start_at FROM public.complex_event_session WHERE complex_event_id=h.event_id;
      END IF;
      IF NOT allow_after AND v.expires_at<=start_at THEN
        RAISE EXCEPTION 'Voucher expires before its allocated event' USING ERRCODE='PT409';
      END IF;
      allocated:=allocated+(part->>'amountMinor')::bigint;
    END LOOP;
    IF allocated IS DISTINCT FROM (allocation->>'amountMinor')::bigint THEN
      RAISE EXCEPTION 'Voucher allocation total mismatch' USING ERRCODE='22023';
    END IF;
    key:='event-funnel:'||NEW.id::text||':voucher:'||v.id::text;
    reserved:=public.voucher_credit_reserve(NEW.tenant_id,key,purchaser,purchaser,ARRAY[v.id],allocated,NEW.currency,true,false);
    IF (reserved->>'voucherMinor')::bigint IS DISTINCT FROM allocated THEN
      RAISE EXCEPTION 'Voucher balance changed; original checkout retained' USING ERRCODE='PT409';
    END IF;
    INSERT INTO public.event_funnel_voucher_reservation(tenant_id,order_id,voucher_id,purchase_id,purchase_key,amount_minor)
      VALUES(NEW.tenant_id,NEW.id,v.id,(reserved->>'id')::uuid,key,allocated);
    total:=total+allocated;
  END LOOP;
  IF total<>expected THEN RAISE EXCEPTION 'Voucher funding total mismatch' USING ERRCODE='22023'; END IF;
  -- Prevent allocating a valid voucher to one event while attributing its
  -- accounting/refund amount to a different event.
  FOR part IN SELECT value FROM jsonb_array_elements(NEW.snapshot->'lines') LOOP
    SELECT coalesce(sum((entry->>'amountMinor')::bigint),0) INTO allocated
      FROM jsonb_array_elements(allocations) a CROSS JOIN LATERAL jsonb_array_elements(a->'lines') entry
      WHERE entry->>'nodeId'=part->>'nodeId' AND entry->>'ticketId'=part->>'ticketId';
    IF allocated IS DISTINCT FROM coalesce((part->>'voucherMinor')::bigint,0) THEN
      RAISE EXCEPTION 'Voucher accounting line mismatch' USING ERRCODE='22023';
    END IF;
  END LOOP;
  RETURN NEW;
END $$;
CREATE TRIGGER event_funnel_voucher_reserve AFTER INSERT ON public.event_funnel_order
  FOR EACH ROW EXECUTE FUNCTION public.event_funnel_voucher_reserve();

CREATE FUNCTION public.event_funnel_voucher_transition()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE reservation public.event_funnel_voucher_reservation; action text;
BEGIN
  IF NEW.state IS NOT DISTINCT FROM OLD.state OR NEW.state NOT IN ('confirmed','cancelled','failed') THEN RETURN NEW; END IF;
  action:=CASE WHEN NEW.state='confirmed' THEN 'commit' ELSE 'release' END;
  IF action='release' AND NEW.verified_payment IS NOT NULL THEN
    RAISE EXCEPTION 'Paid voucher funding cannot be released' USING ERRCODE='PT409';
  END IF;
  -- Existing ledger transitions lock purchase identity before voucher rows.
  -- Take all of those identities first, in the same stable voucher order.
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.tenant_id::text||':'||purchase_key,0))
    FROM public.event_funnel_voucher_reservation
    WHERE tenant_id=NEW.tenant_id AND order_id=NEW.id AND state='held' ORDER BY voucher_id;
  PERFORM 1 FROM public.voucher WHERE tenant_id=NEW.tenant_id AND id IN
    (SELECT voucher_id FROM public.event_funnel_voucher_reservation WHERE tenant_id=NEW.tenant_id AND order_id=NEW.id AND state='held')
    ORDER BY id FOR UPDATE;
  FOR reservation IN SELECT * FROM public.event_funnel_voucher_reservation
    WHERE tenant_id=NEW.tenant_id AND order_id=NEW.id AND state='held' ORDER BY voucher_id LOOP
    PERFORM public.voucher_credit_transition(NEW.tenant_id,reservation.purchase_key,action,
      CASE WHEN action='release' THEN 'cancelled' ELSE NULL END);
    UPDATE public.event_funnel_voucher_reservation SET state=CASE WHEN action='commit' THEN 'committed' ELSE 'released' END
      WHERE tenant_id=NEW.tenant_id AND order_id=NEW.id AND voucher_id=reservation.voucher_id;
  END LOOP;
  RETURN NEW;
END $$;
CREATE TRIGGER event_funnel_voucher_transition AFTER UPDATE OF state ON public.event_funnel_order
  FOR EACH ROW EXECUTE FUNCTION public.event_funnel_voucher_transition();
REVOKE ALL ON FUNCTION public.event_funnel_voucher_reserve(),public.event_funnel_voucher_transition()
  FROM PUBLIC,anon,authenticated,service_role;
CREATE OR REPLACE FUNCTION public.event_funnel_voucher_ready() RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT true $$;
COMMIT;
