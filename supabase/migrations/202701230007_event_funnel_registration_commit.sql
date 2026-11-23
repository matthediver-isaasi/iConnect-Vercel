BEGIN;
-- All registrations and their financial links commit together. Neither invoice
-- workers nor browser retries are allowed to create registrations separately.
CREATE TABLE public.event_funnel_order_booking (
  tenant_id uuid NOT NULL,
  order_id uuid NOT NULL,
  booking_id uuid NOT NULL,
  booking_source text NOT NULL CHECK(booking_source IN ('booking','complex_event_booking')),
  event_id uuid NOT NULL,
  node_id text NOT NULL,
  ticket_id text NOT NULL,
  places integer NOT NULL CHECK(places>0),
  gross_minor bigint NOT NULL CHECK(gross_minor>=0),
  payable_minor bigint NOT NULL CHECK(payable_minor>=0 AND payable_minor<=gross_minor),
  training_fund_minor bigint NOT NULL DEFAULT 0 CHECK(training_fund_minor>=0),
  voucher_minor bigint NOT NULL DEFAULT 0 CHECK(voucher_minor>=0),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(tenant_id,booking_source,booking_id),
  FOREIGN KEY(tenant_id,order_id) REFERENCES public.event_funnel_order(tenant_id,id)
);
CREATE INDEX ON public.event_funnel_order_booking(tenant_id,event_id,ticket_id);
CREATE FUNCTION public.event_funnel_groups_ready() RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT false $$;
CREATE FUNCTION public.event_funnel_create_group(uuid,uuid,uuid,integer) RETURNS void
LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Group fulfillment is not ready' USING ERRCODE='PT409'; END $$;
REVOKE ALL ON FUNCTION public.event_funnel_groups_ready(),public.event_funnel_create_group(uuid,uuid,uuid,integer)
  FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.event_funnel_groups_ready() TO service_role;
CREATE TABLE public.event_funnel_delivery (
  tenant_id uuid NOT NULL,
  order_id uuid NOT NULL,
  kind text NOT NULL CHECK(kind IN ('invoices','confirmations','integrations')),
  state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','running','delivered','needs_review')),
  evidence jsonb NOT NULL,
  lease_token uuid,
  lease_until timestamptz,
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  delivered_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(tenant_id,order_id,kind),
  FOREIGN KEY(tenant_id,order_id) REFERENCES public.event_funnel_order(tenant_id,id)
);
ALTER TABLE public.event_funnel_order_booking ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.event_funnel_delivery ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.event_funnel_order_booking,public.event_funnel_delivery FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION public.event_funnel_finalize_order(p_tenant uuid,p_order uuid,p_evidence jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE o public.event_funnel_order; s public.event_funnel_session; h public.event_funnel_hold;
  line jsonb; registration jsonb; row_data jsonb; inserted jsonb; ev record;
  source_table text; columns_sql text; values_sql text; row_id uuid; count_rows integer:=0;
  total_gross bigint:=0; total_paid bigint:=0; line_gross bigint; line_paid bigint;
  result jsonb; payments jsonb; event_data jsonb; event_places bigint;
BEGIN
  PERFORM ss.id FROM public.event_funnel_session ss JOIN public.event_funnel_order target
    ON target.tenant_id=ss.tenant_id AND target.session_id=ss.id
    WHERE target.tenant_id=p_tenant AND target.id=p_order FOR UPDATE OF ss;
  SELECT * INTO o FROM public.event_funnel_order WHERE tenant_id=p_tenant AND id=p_order FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Order not available' USING ERRCODE='PT404'; END IF;
  IF o.state='confirmed' THEN
    RETURN jsonb_build_object('orderId',o.id,'state','confirmed');
  END IF;
  IF o.state NOT IN ('payable','payment_uncertain') OR p_evidence IS NULL
    OR p_evidence->>'method' IS DISTINCT FROM o.payment_method THEN
    RAISE EXCEPTION 'Order cannot be confirmed' USING ERRCODE='PT409';
  END IF;
  IF o.payment_method='card' THEN
    payments:=p_evidence->'payment';
    IF o.verified_payment IS DISTINCT FROM payments OR o.payment_intent_id IS NULL OR payments->>'id' IS DISTINCT FROM o.payment_intent_id
      OR payments->>'status' IS DISTINCT FROM 'succeeded'
      OR (payments->>'amount')::bigint IS DISTINCT FROM o.payable_minor
      OR (payments->>'amountReceived')::bigint IS DISTINCT FROM o.payable_minor
      OR upper(payments->>'currency') IS DISTINCT FROM o.currency
      OR (payments->>'livemode')::boolean IS DISTINCT FROM (o.snapshot#>>'{paymentAuthority,mode}'='live') THEN
      RAISE EXCEPTION 'Payment authority mismatch' USING ERRCODE='PT409';
    END IF;
  ELSIF o.snapshot->'submissionAccepted' IS DISTINCT FROM 'true'::jsonb THEN
    RAISE EXCEPTION 'Submission was not accepted' USING ERRCODE='PT409';
  END IF;
  SELECT * INTO STRICT s FROM public.event_funnel_session WHERE tenant_id=p_tenant AND id=o.session_id;
  IF s.state NOT IN ('payable','payment_uncertain') THEN RAISE EXCEPTION 'Session cannot be confirmed' USING ERRCODE='PT409'; END IF;
  IF jsonb_array_length(o.snapshot->'lines') IS DISTINCT FROM
      (SELECT count(*)::integer FROM public.event_funnel_hold WHERE tenant_id=p_tenant AND session_id=s.id)
    OR jsonb_array_length(o.snapshot->'lines') IS DISTINCT FROM
      (SELECT count(DISTINCT (value->>'nodeId',value->>'ticketId'))::integer FROM jsonb_array_elements(o.snapshot->'lines')) THEN
    RAISE EXCEPTION 'Held selection does not match order' USING ERRCODE='PT409';
  END IF;
  -- Acquire every event before removing this order's temporary inventory.
  FOR ev IN SELECT DISTINCT event_kind,event_id FROM public.event_funnel_hold
    WHERE tenant_id=p_tenant AND session_id=s.id ORDER BY event_kind,event_id LOOP
    IF ev.event_kind='simple' THEN
      PERFORM id FROM public.event WHERE tenant_id=p_tenant AND id=ev.event_id FOR UPDATE;
    ELSE
      PERFORM id FROM public.complex_event WHERE tenant_id=p_tenant AND id=ev.event_id FOR UPDATE;
    END IF;
    IF NOT FOUND THEN RAISE EXCEPTION 'Purchased event unavailable' USING ERRCODE='PT409'; END IF;
  END LOOP;
  UPDATE public.event_funnel_session SET state='confirmed',revision=revision+1,updated_at=clock_timestamp()
    WHERE tenant_id=p_tenant AND id=s.id;
  FOR line IN SELECT value FROM jsonb_array_elements(o.snapshot->'lines') LOOP
    SELECT * INTO h FROM public.event_funnel_hold WHERE tenant_id=p_tenant AND session_id=s.id
      AND node_id=line->>'nodeId' AND ticket_id=line->>'ticketId';
    IF NOT FOUND OR h.event_id IS DISTINCT FROM (line->>'eventId')::uuid
      OR h.event_kind IS DISTINCT FROM line->>'eventKind'
      OR h.quantity IS DISTINCT FROM (line->>'quantity')::integer
      OR h.places IS DISTINCT FROM (line->>'places')::integer
      OR h.price_snapshot IS DISTINCT FROM line->'priceSnapshot'
      OR jsonb_typeof(line->'registrations') IS DISTINCT FROM 'array'
      OR jsonb_array_length(line->'registrations') IS DISTINCT FROM h.quantity THEN
      RAISE EXCEPTION 'Registration plan does not match held inventory' USING ERRCODE='PT409';
    END IF;
    -- Group fulfillment and funding fences must be installed before those
    -- snapshots can enter this finalizer; never manufacture placeholder people.
    IF (h.places<>h.quantity AND (h.event_kind<>'simple' OR NOT public.event_funnel_groups_ready()))
      OR (coalesce((line->>'voucherMinor')::bigint,0)<>0 AND NOT public.event_funnel_voucher_ready())
      OR (coalesce((line->>'trainingFundMinor')::bigint,0)<>0 AND NOT public.event_funnel_training_ready()) THEN
      RAISE EXCEPTION 'Required fulfillment adapter unavailable' USING ERRCODE='PT409';
    END IF;
    source_table:=CASE WHEN h.event_kind='simple' THEN 'booking' ELSE 'complex_event_booking' END;
    line_gross:=0; line_paid:=0;
    FOR registration IN SELECT value FROM jsonb_array_elements(line->'registrations') LOOP
      row_data:=registration->'row'; row_id:=(registration->>'id')::uuid;
      IF row_id IS NULL OR row_data->>'id' IS DISTINCT FROM row_id::text
        OR (row_data->>'tenant_id')::uuid IS DISTINCT FROM p_tenant
        OR (row_data->>'event_id')::uuid IS DISTINCT FROM h.event_id
        OR (row_data->>'member_id')::uuid IS DISTINCT FROM s.member_id
        OR coalesce(row_data->>'ticket_class_id','default') IS DISTINCT FROM h.ticket_id
        OR row_data->>'status' IS DISTINCT FROM 'confirmed'
        OR row_data ? 'stripe_payment_intent_id'
        OR (registration->>'places')::integer IS DISTINCT FROM h.places/h.quantity
        OR (registration->>'grossMinor')::bigint IS DISTINCT FROM (registration->>'payableMinor')::bigint+coalesce((registration->>'trainingFundMinor')::bigint,0)+coalesce((registration->>'voucherMinor')::bigint,0)
        OR coalesce((registration->>'trainingFundMinor')::bigint,0)<0
        OR coalesce((registration->>'voucherMinor')::bigint,0)<0
        OR coalesce((row_data->>'training_fund_amount')::numeric,0)*100 IS DISTINCT FROM coalesce((registration->>'trainingFundMinor')::numeric,0)
        OR coalesce((row_data->>'voucher_amount')::numeric,0)*100 IS DISTINCT FROM coalesce((registration->>'voucherMinor')::numeric,0)
        OR (registration->>'payableMinor')::bigint<0 THEN
        RAISE EXCEPTION 'Invalid individual registration evidence' USING ERRCODE='22023';
      END IF;
      -- Explicit columns only: missing schema fails the whole transaction.
      IF EXISTS(SELECT 1 FROM jsonb_object_keys(row_data) k WHERE NOT EXISTS(
        SELECT 1 FROM pg_attribute WHERE attrelid=format('public.%I',source_table)::regclass
          AND attname=k AND attnum>0 AND NOT attisdropped)) THEN
        RAISE EXCEPTION 'Registration schema is not ready' USING ERRCODE='PT409';
      END IF;
      SELECT string_agg(format('%I',k),',' ORDER BY k),string_agg(format('(x.r).%I',k),',' ORDER BY k)
        INTO columns_sql,values_sql FROM jsonb_object_keys(row_data) k;
      EXECUTE format('INSERT INTO public.%I(%s) SELECT %s FROM (SELECT jsonb_populate_record(NULL::public.%I,$1) r) x RETURNING to_jsonb(%I.*)',
        source_table,columns_sql,values_sql,source_table,source_table) INTO inserted USING row_data;
      INSERT INTO public.event_funnel_order_booking(tenant_id,order_id,booking_id,booking_source,event_id,node_id,ticket_id,places,gross_minor,payable_minor,training_fund_minor,voucher_minor)
        VALUES(p_tenant,p_order,row_id,source_table,h.event_id,h.node_id,h.ticket_id,h.places/h.quantity,
          (registration->>'grossMinor')::bigint,(registration->>'payableMinor')::bigint,coalesce((registration->>'trainingFundMinor')::bigint,0),coalesce((registration->>'voucherMinor')::bigint,0));
      IF h.places>h.quantity THEN PERFORM public.event_funnel_create_group(p_tenant,p_order,row_id,h.places/h.quantity); END IF;
      count_rows:=count_rows+1;
      line_gross:=line_gross+(registration->>'grossMinor')::bigint;
      line_paid:=line_paid+(registration->>'payableMinor')::bigint;
    END LOOP;
    IF line_gross IS DISTINCT FROM (line->>'amountMinor')::bigint OR line_paid IS DISTINCT FROM (line->>'payableMinor')::bigint THEN
      RAISE EXCEPTION 'Registration financial allocation mismatch' USING ERRCODE='22023';
    END IF;
    total_gross:=total_gross+line_gross; total_paid:=total_paid+line_paid;
  END LOOP;
  IF count_rows=0 OR total_paid IS DISTINCT FROM o.payable_minor
    OR total_gross-total_paid IS DISTINCT FROM coalesce((o.snapshot->>'trainingFundMinor')::bigint,0)+coalesce((o.snapshot->>'voucherMinor')::bigint,0) THEN
    RAISE EXCEPTION 'Order allocation mismatch' USING ERRCODE='22023';
  END IF;
  FOR ev IN SELECT event_kind,event_id,sum(places) places FROM public.event_funnel_hold
    WHERE tenant_id=p_tenant AND session_id=s.id GROUP BY event_kind,event_id ORDER BY event_kind,event_id LOOP
    source_table:=CASE WHEN ev.event_kind='simple' THEN 'event' ELSE 'complex_event' END;
    EXECUTE format('SELECT to_jsonb(e) FROM public.%I e WHERE tenant_id=$1 AND id=$2',source_table) INTO event_data USING p_tenant,ev.event_id;
    IF public.event_funnel_counter_is_finite(ev.event_kind,event_data) THEN
      IF (event_data->>'available_seats')::bigint < ev.places THEN
        RAISE EXCEPTION 'Reserved legacy inventory needs reconciliation' USING ERRCODE='PT409';
      END IF;
      EXECUTE format('UPDATE public.%I SET available_seats=available_seats-$1 WHERE tenant_id=$2 AND id=$3',source_table)
        USING ev.places,p_tenant,ev.event_id;
    END IF;
  END LOOP;
  INSERT INTO public.event_funnel_delivery(tenant_id,order_id,kind,evidence)
    SELECT p_tenant,p_order,k,o.snapshot||jsonb_build_object('paymentEvidence',p_evidence)
      FROM unnest(ARRAY['invoices','confirmations','integrations']) k;
  UPDATE public.event_funnel_order SET state='confirmed',updated_at=clock_timestamp()
    WHERE tenant_id=p_tenant AND id=p_order;
  RETURN jsonb_build_object('orderId',o.id,'state','confirmed');
END $$;
REVOKE ALL ON FUNCTION public.event_funnel_finalize_order(uuid,uuid,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.event_funnel_finalize_order(uuid,uuid,jsonb) TO service_role;

CREATE INDEX event_funnel_delivery_due ON public.event_funnel_delivery(kind,next_attempt_at,order_id)
  WHERE state IN ('pending','running');

CREATE FUNCTION public.event_funnel_recovery_claim(p_limit integer DEFAULT 8)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE result jsonb;
BEGIN
  IF p_limit IS NULL OR p_limit<1 OR p_limit>20 THEN RAISE EXCEPTION 'Invalid recovery limit' USING ERRCODE='22023'; END IF;
  WITH candidates AS (
    SELECT id FROM public.event_funnel_order WHERE state IN ('payable','payment_uncertain')
      AND next_attempt_at<=clock_timestamp() AND (lease_until IS NULL OR lease_until<=clock_timestamp())
    ORDER BY next_attempt_at,created_at,id LIMIT p_limit FOR UPDATE SKIP LOCKED
  ), claimed AS (
    UPDATE public.event_funnel_order target SET lease_token=gen_random_uuid(),lease_until=clock_timestamp()+interval '120 seconds'
    FROM candidates WHERE target.id=candidates.id RETURNING target.*
  ) SELECT coalesce(jsonb_agg(to_jsonb(claimed)),'[]'::jsonb) INTO result FROM claimed;
  RETURN result;
END $$;
CREATE FUNCTION public.event_funnel_recovery_finish(p_tenant uuid,p_order uuid,p_token uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
  UPDATE public.event_funnel_order SET lease_token=NULL,lease_until=NULL,next_attempt_at=clock_timestamp()+interval '60 seconds'
    WHERE tenant_id=p_tenant AND id=p_order AND lease_token=p_token AND lease_until>clock_timestamp();
  RETURN FOUND;
END $$;
CREATE FUNCTION public.event_funnel_delivery_claim(p_kind text,p_limit integer DEFAULT 8)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE result jsonb;
BEGIN
  IF p_kind IS NULL OR p_kind NOT IN ('invoices','confirmations','integrations') OR p_limit IS NULL OR p_limit<1 OR p_limit>20 THEN
    RAISE EXCEPTION 'Invalid delivery claim' USING ERRCODE='22023';
  END IF;
  WITH candidates AS (
    SELECT tenant_id,order_id,kind FROM public.event_funnel_delivery WHERE kind=p_kind AND state IN ('pending','running')
      AND next_attempt_at<=clock_timestamp() AND (lease_until IS NULL OR lease_until<=clock_timestamp())
    ORDER BY next_attempt_at,created_at,order_id LIMIT p_limit FOR UPDATE SKIP LOCKED
  ), claimed AS (
    UPDATE public.event_funnel_delivery target SET state='running',lease_token=gen_random_uuid(),
      lease_until=clock_timestamp()+interval '120 seconds',attempts=attempts+1
    FROM candidates WHERE target.tenant_id=candidates.tenant_id AND target.order_id=candidates.order_id AND target.kind=candidates.kind
    RETURNING target.*
  ) SELECT coalesce(jsonb_agg(to_jsonb(claimed)),'[]'::jsonb) INTO result FROM claimed;
  RETURN result;
END $$;
CREATE FUNCTION public.event_funnel_delivery_finish(p_tenant uuid,p_order uuid,p_kind text,p_token uuid,p_status text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
  IF p_status IS NULL OR p_status NOT IN ('delivered','retry','needs_review') THEN
    RAISE EXCEPTION 'Invalid delivery outcome' USING ERRCODE='22023';
  END IF;
  UPDATE public.event_funnel_delivery SET state=CASE WHEN p_status='retry' THEN 'pending' ELSE p_status END,
    lease_token=NULL,lease_until=NULL,next_attempt_at=clock_timestamp()+interval '60 seconds',
    delivered_at=CASE WHEN p_status='delivered' THEN clock_timestamp() ELSE NULL END
    WHERE tenant_id=p_tenant AND order_id=p_order AND kind=p_kind AND lease_token=p_token AND lease_until>clock_timestamp();
  RETURN FOUND;
END $$;
REVOKE ALL ON FUNCTION public.event_funnel_recovery_claim(integer),public.event_funnel_recovery_finish(uuid,uuid,uuid),
  public.event_funnel_delivery_claim(text,integer),public.event_funnel_delivery_finish(uuid,uuid,text,uuid,text)
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.event_funnel_recovery_claim(integer),public.event_funnel_recovery_finish(uuid,uuid,uuid),
  public.event_funnel_delivery_claim(text,integer),public.event_funnel_delivery_finish(uuid,uuid,text,uuid,text)
  TO service_role;
COMMIT;
