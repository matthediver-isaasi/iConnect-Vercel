-- Aggregate payment authority. This migration does not enable publishing.
BEGIN;
CREATE FUNCTION public.event_funnel_training_ready() RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT false $$;
REVOKE ALL ON FUNCTION public.event_funnel_training_ready() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.event_funnel_training_ready() TO service_role;
CREATE FUNCTION public.event_funnel_voucher_ready() RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT false $$;
REVOKE ALL ON FUNCTION public.event_funnel_voucher_ready() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.event_funnel_voucher_ready() TO service_role;
CREATE TABLE public.event_funnel_order (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  session_id uuid NOT NULL,
  session_revision integer NOT NULL,
  version_id uuid NOT NULL,
  state text NOT NULL DEFAULT 'payable' CHECK(state IN ('payable','payment_uncertain','confirming','confirmed','cancelled','failed')),
  payment_method text NOT NULL CHECK(payment_method IN ('card','account','public_invoice_po','free')),
  currency text NOT NULL CHECK(currency ~ '^[A-Z]{3}$'),
  payable_minor bigint NOT NULL CHECK(payable_minor>=0),
  snapshot jsonb NOT NULL CHECK(jsonb_typeof(snapshot)='object' AND octet_length(snapshot::text)<=1048576),
  payment_request jsonb,
  payment_requested_at timestamptz,
  payment_intent_id text,
  verified_payment jsonb,
  verified_payment_at timestamptz,
  uncertainty_code text,
  lease_token uuid,
  lease_until timestamptz,
  next_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(tenant_id,id),
  UNIQUE(tenant_id,payment_intent_id),
  FOREIGN KEY(tenant_id,session_id) REFERENCES public.event_funnel_session(tenant_id,id),
  FOREIGN KEY(tenant_id,version_id) REFERENCES public.event_funnel_version(tenant_id,id)
);
CREATE UNIQUE INDEX event_funnel_one_open_order ON public.event_funnel_order(tenant_id,session_id)
  WHERE state NOT IN ('cancelled','failed');
CREATE INDEX event_funnel_order_due ON public.event_funnel_order(next_attempt_at,created_at)
  WHERE state IN ('payable','payment_uncertain','confirming');

CREATE FUNCTION public.event_funnel_order_immutable()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
  IF ROW(NEW.id,NEW.tenant_id,NEW.session_id,NEW.session_revision,NEW.version_id,NEW.payment_method,NEW.currency,NEW.payable_minor,NEW.snapshot,NEW.created_at)
    IS DISTINCT FROM ROW(OLD.id,OLD.tenant_id,OLD.session_id,OLD.session_revision,OLD.version_id,OLD.payment_method,OLD.currency,OLD.payable_minor,OLD.snapshot,OLD.created_at)
    OR OLD.payment_request IS NOT NULL AND ROW(NEW.payment_request,NEW.payment_requested_at) IS DISTINCT FROM ROW(OLD.payment_request,OLD.payment_requested_at)
    OR OLD.payment_intent_id IS NOT NULL AND NEW.payment_intent_id IS DISTINCT FROM OLD.payment_intent_id
    OR OLD.verified_payment IS NOT NULL AND ROW(NEW.verified_payment,NEW.verified_payment_at) IS DISTINCT FROM ROW(OLD.verified_payment,OLD.verified_payment_at)
    OR OLD.state IN ('confirmed','cancelled','failed') AND NEW.state IS DISTINCT FROM OLD.state THEN
    RAISE EXCEPTION 'Original order authority is immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER event_funnel_order_immutable BEFORE UPDATE ON public.event_funnel_order
  FOR EACH ROW EXECUTE FUNCTION public.event_funnel_order_immutable();

CREATE FUNCTION public.event_funnel_prepare_order(
  p_tenant uuid,p_id uuid,p_member uuid,p_capability_hash text,p_expected_revision integer,p_snapshot jsonb
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE s public.event_funnel_session; o public.event_funnel_order; h public.event_funnel_hold; line jsonb;
  total bigint:=0; training bigint:=0; vouchers bigint:=0; g jsonb; method text; currency text; ev record;
BEGIN
  s:=public.event_funnel_owned_session(p_tenant,p_id,p_member,p_capability_hash);
  IF jsonb_typeof(p_snapshot)='object' THEN
    p_snapshot:=p_snapshot||jsonb_build_object('reservationExpiresAt',s.expires_at);
  END IF;
  SELECT * INTO o FROM public.event_funnel_order WHERE tenant_id=p_tenant AND session_id=p_id
    AND state NOT IN ('cancelled','failed') FOR UPDATE;
  IF FOUND THEN
    IF o.snapshot IS DISTINCT FROM p_snapshot OR o.session_revision IS DISTINCT FROM p_expected_revision THEN
      RAISE EXCEPTION 'Resume original checkout without paying again' USING ERRCODE='PT409';
    END IF;
    RETURN to_jsonb(o);
  END IF;
  IF s.revision IS DISTINCT FROM p_expected_revision OR s.state<>'held' OR s.expires_at<=clock_timestamp() THEN
    RAISE EXCEPTION 'Reservation changed or expired' USING ERRCODE='PT409';
  END IF;
  IF p_snapshot IS NULL OR p_snapshot->>'version' IS DISTINCT FROM '1'
    OR p_snapshot->>'submissionAccepted' IS DISTINCT FROM 'true'
    OR jsonb_typeof(p_snapshot->'lines') IS DISTINCT FROM 'array'
    OR jsonb_array_length(p_snapshot->'lines') NOT BETWEEN 1 AND 10000
    OR jsonb_typeof(p_snapshot->'purchaser') IS DISTINCT FROM 'object'
    OR octet_length(p_snapshot::text)>1048576 THEN
    RAISE EXCEPTION 'Verified checkout terms required' USING ERRCODE='22023';
  END IF;
  SELECT graph INTO g FROM public.event_funnel_version WHERE tenant_id=p_tenant AND id=s.version_id;
  -- Match inventory conversion ordering before any organization/voucher lock.
  FOR ev IN SELECT DISTINCT event_kind,event_id FROM public.event_funnel_hold
    WHERE tenant_id=p_tenant AND session_id=p_id ORDER BY event_kind,event_id LOOP
    IF ev.event_kind='simple' THEN
      PERFORM id FROM public.event WHERE tenant_id=p_tenant AND id=ev.event_id FOR UPDATE;
    ELSE
      PERFORM id FROM public.complex_event WHERE tenant_id=p_tenant AND id=ev.event_id FOR UPDATE;
    END IF;
    IF NOT FOUND THEN RAISE EXCEPTION 'Selected event unavailable' USING ERRCODE='PT409'; END IF;
  END LOOP;
  IF NOT EXISTS(SELECT 1 FROM public.event_funnel_hold WHERE tenant_id=p_tenant AND session_id=p_id
    AND node_id=g->>'entry' AND price_snapshot->'purchaser'=p_snapshot->'purchaser') THEN
    RAISE EXCEPTION 'Original purchaser changed' USING ERRCODE='22023';
  END IF;
  IF p_snapshot->>'invoiceMode' IS DISTINCT FROM g->>'invoiceMode' THEN
    RAISE EXCEPTION 'Invoice mode changed' USING ERRCODE='22023';
  END IF;
  method:=p_snapshot->>'paymentMethod'; currency:=p_snapshot->>'currency';
  IF method NOT IN ('card','account','public_invoice_po','free') OR currency !~ '^[A-Z]{3}$'
    OR method='account' AND s.member_id IS NULL OR method='public_invoice_po' AND s.member_id IS NOT NULL THEN
    RAISE EXCEPTION 'Invalid purchaser payment authority' USING ERRCODE='22023';
  END IF;
  -- Until the funding fence is installed, no caller can obtain a discounted
  -- provider request by merely supplying an uncommitted credit allocation.
  IF (coalesce((p_snapshot->>'voucherMinor')::bigint,0)<>0 AND NOT public.event_funnel_voucher_ready())
    OR (coalesce((p_snapshot->>'trainingFundMinor')::bigint,0)<>0 AND NOT public.event_funnel_training_ready())
    OR jsonb_array_length(coalesce(p_snapshot->'discounts','[]'))<>0 THEN
    RAISE EXCEPTION 'Aggregate funding reservation is not installed' USING ERRCODE='PT409';
  END IF;
  IF (SELECT count(*) FROM public.event_funnel_hold WHERE tenant_id=p_tenant AND session_id=p_id)
    <>jsonb_array_length(p_snapshot->'lines')
    OR (SELECT count(DISTINCT jsonb_build_array(l->>'nodeId',l->>'ticketId')) FROM jsonb_array_elements(p_snapshot->'lines') l)
      <>jsonb_array_length(p_snapshot->'lines') THEN
    RAISE EXCEPTION 'Held selection changed' USING ERRCODE='PT409';
  END IF;
  FOR line IN SELECT value FROM jsonb_array_elements(p_snapshot->'lines') LOOP
    SELECT * INTO h FROM public.event_funnel_hold WHERE tenant_id=p_tenant AND session_id=p_id
      AND node_id=line->>'nodeId' AND ticket_id=line->>'ticketId';
    IF NOT FOUND OR h.quantity IS DISTINCT FROM (line->>'quantity')::integer
      OR h.places IS DISTINCT FROM (line->>'places')::integer OR h.price_snapshot IS DISTINCT FROM line->'priceSnapshot'
      OR h.price_snapshot->>'currency' IS DISTINCT FROM currency
      OR (line->>'amountMinor')::bigint<0 THEN
      RAISE EXCEPTION 'Held price or quantity changed' USING ERRCODE='PT409';
    END IF;
    IF coalesce((line->>'trainingFundMinor')::bigint,0)<0
      OR coalesce((line->>'voucherMinor')::bigint,0)<0
      OR coalesce((line->>'trainingFundMinor')::bigint,0)+coalesce((line->>'voucherMinor')::bigint,0)>(line->>'amountMinor')::bigint
      OR coalesce((line->>'payableMinor')::bigint,(line->>'amountMinor')::bigint)
        IS DISTINCT FROM (line->>'amountMinor')::bigint-coalesce((line->>'trainingFundMinor')::bigint,0)-coalesce((line->>'voucherMinor')::bigint,0) THEN
      RAISE EXCEPTION 'Invalid line funding allocation' USING ERRCODE='22023';
    END IF;
    IF coalesce((line->>'payableMinor')::bigint,(line->>'amountMinor')::bigint)>0 AND NOT (h.price_snapshot->'paymentMethods' ? method) THEN
      RAISE EXCEPTION 'Payment method is not permitted for every payable item' USING ERRCODE='22023';
    END IF;
    total:=total+(line->>'amountMinor')::bigint;
    training:=training+coalesce((line->>'trainingFundMinor')::bigint,0);
    vouchers:=vouchers+coalesce((line->>'voucherMinor')::bigint,0);
  END LOOP;
  IF training IS DISTINCT FROM coalesce((p_snapshot->>'trainingFundMinor')::bigint,0)
    OR vouchers IS DISTINCT FROM coalesce((p_snapshot->>'voucherMinor')::bigint,0) OR training+vouchers>total
    OR total-training-vouchers IS DISTINCT FROM (p_snapshot->>'payableMinor')::bigint OR (total-training-vouchers=0) IS DISTINCT FROM (method='free') THEN
    RAISE EXCEPTION 'Checkout total changed' USING ERRCODE='22023';
  END IF;
  IF s.expires_at<=clock_timestamp() THEN RAISE EXCEPTION 'Reservation expired' USING ERRCODE='PT409'; END IF;
  INSERT INTO public.event_funnel_order(tenant_id,session_id,session_revision,version_id,payment_method,currency,payable_minor,snapshot)
    VALUES(p_tenant,p_id,s.revision,s.version_id,method,currency,total-training-vouchers,p_snapshot) RETURNING * INTO o;
  UPDATE public.event_funnel_session SET state='payable',revision=revision+1,updated_at=clock_timestamp()
    WHERE tenant_id=p_tenant AND id=p_id;
  RETURN to_jsonb(o);
END $$;

CREATE FUNCTION public.event_funnel_order_read(p_tenant uuid,p_order uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
  SELECT to_jsonb(o) FROM public.event_funnel_order o WHERE tenant_id=p_tenant AND id=p_order
$$;
CREATE FUNCTION public.event_funnel_owned_order(p_tenant uuid,p_id uuid,p_member uuid,p_capability_hash text,p_order uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE result jsonb;
BEGIN
  PERFORM public.event_funnel_owned_session(p_tenant,p_id,p_member,p_capability_hash);
  SELECT to_jsonb(o) INTO result FROM public.event_funnel_order o WHERE tenant_id=p_tenant AND session_id=p_id AND id=p_order;
  IF result IS NULL THEN RAISE EXCEPTION 'Order not available' USING ERRCODE='PT404'; END IF;
  RETURN result;
END $$;
CREATE FUNCTION public.event_funnel_session_order(p_tenant uuid,p_id uuid,p_member uuid,p_capability_hash text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE result jsonb;
BEGIN
  PERFORM public.event_funnel_owned_session(p_tenant,p_id,p_member,p_capability_hash);
  SELECT to_jsonb(o) INTO result FROM public.event_funnel_order o
    WHERE o.tenant_id=p_tenant AND o.session_id=p_id AND o.state NOT IN ('cancelled','failed')
    ORDER BY o.created_at DESC,o.id DESC LIMIT 1;
  RETURN result;
END $$;
REVOKE ALL ON FUNCTION public.event_funnel_session_order(uuid,uuid,uuid,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.event_funnel_session_order(uuid,uuid,uuid,text) TO service_role;

CREATE FUNCTION public.event_funnel_payment_request(p_tenant uuid,p_order uuid,p_request jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE o public.event_funnel_order;
BEGIN
  PERFORM s.id FROM public.event_funnel_session s JOIN public.event_funnel_order target ON target.tenant_id=s.tenant_id AND target.session_id=s.id
    WHERE target.tenant_id=p_tenant AND target.id=p_order FOR UPDATE OF s;
  SELECT * INTO o FROM public.event_funnel_order WHERE tenant_id=p_tenant AND id=p_order FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Order not available' USING ERRCODE='PT404'; END IF;
  IF o.snapshot->>'reservationExpiresAt' IS NULL
    OR (o.snapshot->>'reservationExpiresAt')::timestamptz<=clock_timestamp() THEN
    RAISE EXCEPTION 'Reservation expired before payment started' USING ERRCODE='PT409';
  END IF;
  IF p_request IS NULL OR jsonb_typeof(p_request) IS DISTINCT FROM 'object'
    OR o.state NOT IN ('payable','payment_uncertain') OR o.payment_method<>'card'
    OR p_request->>'amount' IS DISTINCT FROM o.payable_minor::text
    OR upper(p_request->>'currency') IS DISTINCT FROM o.currency
    OR p_request#>>'{metadata,event_funnel_order_id}' IS DISTINCT FROM o.id::text
    OR p_request#>>'{metadata,event_funnel_session_id}' IS DISTINCT FROM o.session_id::text
    OR p_request#>>'{metadata,tenant_id}' IS DISTINCT FROM o.tenant_id::text
    OR p_request#>>'{metadata,feature}' IS DISTINCT FROM 'events'
    OR p_request->'payment_method_types' IS DISTINCT FROM '["card"]'::jsonb
    OR p_request->>'receipt_email' IS DISTINCT FROM o.snapshot#>>'{purchaser,email}'
    OR p_request-ARRAY['amount','currency','payment_method_types','receipt_email','metadata']<>'{}'::jsonb
    OR o.payment_request IS NOT NULL AND o.payment_request IS DISTINCT FROM p_request THEN
    RAISE EXCEPTION 'Original payment request changed' USING ERRCODE='PT409';
  END IF;
  IF o.payment_request IS NULL THEN
    UPDATE public.event_funnel_order SET payment_request=p_request,payment_requested_at=clock_timestamp(),updated_at=clock_timestamp()
      WHERE tenant_id=p_tenant AND id=p_order RETURNING * INTO o;
  END IF;
  RETURN to_jsonb(o);
END $$;
CREATE FUNCTION public.event_funnel_payment_bind(p_tenant uuid,p_order uuid,p_payment text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE o public.event_funnel_order;
BEGIN
  PERFORM s.id FROM public.event_funnel_session s JOIN public.event_funnel_order target ON target.tenant_id=s.tenant_id AND target.session_id=s.id
    WHERE target.tenant_id=p_tenant AND target.id=p_order FOR UPDATE OF s;
  SELECT * INTO o FROM public.event_funnel_order WHERE tenant_id=p_tenant AND id=p_order FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Order not available' USING ERRCODE='PT404'; END IF;
  IF p_payment IS NULL OR p_payment !~ '^pi_[A-Za-z0-9]+$' OR o.payment_request IS NULL
    OR o.state NOT IN ('payable','payment_uncertain','confirming','confirmed')
    OR o.payment_intent_id IS NOT NULL AND o.payment_intent_id<>p_payment THEN
    RAISE EXCEPTION 'Original payment binding changed' USING ERRCODE='PT409';
  END IF;
  UPDATE public.event_funnel_order SET payment_intent_id=p_payment,updated_at=clock_timestamp()
    WHERE tenant_id=p_tenant AND id=p_order RETURNING * INTO o;
  RETURN to_jsonb(o);
END $$;
CREATE FUNCTION public.event_funnel_payment_uncertain(p_tenant uuid,p_order uuid,p_reason text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE sid uuid;
BEGIN
  PERFORM s.id FROM public.event_funnel_session s JOIN public.event_funnel_order o ON o.tenant_id=s.tenant_id AND o.session_id=s.id
    WHERE o.tenant_id=p_tenant AND o.id=p_order FOR UPDATE OF s;
  IF p_reason IS NULL OR p_reason NOT IN ('original_create_window_elapsed','provider_create_unconfirmed','provider_read_unconfirmed',
    'cancel_requires_original_create','provider_cancel_unconfirmed') THEN RAISE EXCEPTION 'Invalid uncertainty reason'; END IF;
  UPDATE public.event_funnel_order SET state='payment_uncertain',uncertainty_code=p_reason,updated_at=clock_timestamp()
    WHERE tenant_id=p_tenant AND id=p_order AND state IN ('payable','payment_uncertain') RETURNING session_id INTO sid;
  IF sid IS NULL THEN RETURN false; END IF;
  UPDATE public.event_funnel_session SET state='payment_uncertain',updated_at=clock_timestamp()
    WHERE tenant_id=p_tenant AND id=sid AND state IN ('payable','payment_uncertain');
  RETURN true;
END $$;
CREATE FUNCTION public.event_funnel_record_payment(p_tenant uuid,p_order uuid,p_evidence jsonb)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE o public.event_funnel_order;
BEGIN
  PERFORM s.id FROM public.event_funnel_session s JOIN public.event_funnel_order target ON target.tenant_id=s.tenant_id AND target.session_id=s.id
    WHERE target.tenant_id=p_tenant AND target.id=p_order FOR UPDATE OF s;
  SELECT * INTO o FROM public.event_funnel_order WHERE tenant_id=p_tenant AND id=p_order FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Order unavailable' USING ERRCODE='PT404'; END IF;
  IF o.state NOT IN ('payable','payment_uncertain','confirmed') OR o.payment_method<>'card'
    OR o.payment_intent_id IS NULL OR p_evidence IS NULL
    OR p_evidence->>'id' IS DISTINCT FROM o.payment_intent_id OR p_evidence->>'status' IS DISTINCT FROM 'succeeded'
    OR (p_evidence->>'amount')::bigint IS DISTINCT FROM o.payable_minor
    OR (p_evidence->>'amountReceived')::bigint IS DISTINCT FROM o.payable_minor
    OR p_evidence->>'currency' IS DISTINCT FROM o.currency
    OR (p_evidence->>'livemode')::boolean IS DISTINCT FROM (o.snapshot#>>'{paymentAuthority,mode}'='live') THEN
    RAISE EXCEPTION 'Payment evidence mismatch' USING ERRCODE='PT409';
  END IF;
  IF o.verified_payment IS NOT NULL THEN
    IF o.verified_payment IS DISTINCT FROM p_evidence THEN RAISE EXCEPTION 'Original payment evidence changed' USING ERRCODE='PT409'; END IF;
    RETURN true;
  END IF;
  UPDATE public.event_funnel_order SET verified_payment=p_evidence,verified_payment_at=clock_timestamp(),updated_at=clock_timestamp()
    WHERE tenant_id=p_tenant AND id=p_order;
  RETURN true;
END $$;
REVOKE ALL ON FUNCTION public.event_funnel_record_payment(uuid,uuid,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.event_funnel_record_payment(uuid,uuid,jsonb) TO service_role;

CREATE FUNCTION public.event_funnel_release_order(p_tenant uuid,p_order uuid,p_evidence jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE o public.event_funnel_order;
BEGIN
  PERFORM s.id FROM public.event_funnel_session s JOIN public.event_funnel_order target ON target.tenant_id=s.tenant_id AND target.session_id=s.id
    WHERE target.tenant_id=p_tenant AND target.id=p_order FOR UPDATE OF s;
  SELECT * INTO o FROM public.event_funnel_order WHERE tenant_id=p_tenant AND id=p_order FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Order not available' USING ERRCODE='PT404'; END IF;
  IF o.state='cancelled' THEN RETURN jsonb_build_object('orderId',o.id,'state','cancelled'); END IF;
  IF o.state IN ('confirmed','confirming') OR o.verified_payment IS NOT NULL OR p_evidence IS NULL OR o.payment_method<>'card'
    OR ((p_evidence->>'outcome'='not_started' AND o.payment_requested_at IS NULL AND o.payment_intent_id IS NULL)
      OR (p_evidence->>'outcome'='cancelled' AND o.payment_intent_id IS NOT NULL
        AND p_evidence->>'paymentIntentId'=o.payment_intent_id)) IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'Verified terminal payment outcome required' USING ERRCODE='PT409';
  END IF;
  UPDATE public.event_funnel_order SET state='cancelled',updated_at=clock_timestamp() WHERE tenant_id=p_tenant AND id=p_order;
  -- A verified cancelled payment may return to an existing live reservation,
  -- but never extends its original deadline. Expired selections need explicit
  -- re-reservation; both paths retain answers without manufacturing bookings.
  UPDATE public.event_funnel_session SET state=CASE WHEN expires_at>clock_timestamp() THEN 'held' ELSE 'expired' END,
    revision=revision+1,updated_at=clock_timestamp()
    WHERE tenant_id=p_tenant AND id=o.session_id;
  RETURN jsonb_build_object('orderId',o.id,'state','cancelled');
END $$;
ALTER TABLE public.event_funnel_order ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.event_funnel_order FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.event_funnel_order_immutable(),
  public.event_funnel_prepare_order(uuid,uuid,uuid,text,integer,jsonb),public.event_funnel_order_read(uuid,uuid),
  public.event_funnel_owned_order(uuid,uuid,uuid,text,uuid),public.event_funnel_payment_request(uuid,uuid,jsonb),
  public.event_funnel_payment_bind(uuid,uuid,text),public.event_funnel_payment_uncertain(uuid,uuid,text),
  public.event_funnel_release_order(uuid,uuid,jsonb)
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.event_funnel_prepare_order(uuid,uuid,uuid,text,integer,jsonb),public.event_funnel_order_read(uuid,uuid),
  public.event_funnel_owned_order(uuid,uuid,uuid,text,uuid),public.event_funnel_payment_request(uuid,uuid,jsonb),
  public.event_funnel_payment_bind(uuid,uuid,text),public.event_funnel_payment_uncertain(uuid,uuid,text),
  public.event_funnel_release_order(uuid,uuid,jsonb) TO service_role;
COMMIT;
