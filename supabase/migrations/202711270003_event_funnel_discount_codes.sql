-- Event funnel discount codes (source event only).
-- Owner decision: a discount code in a funnel applies only to the source
-- (entry) event purchase. Never to add-ons, extra events or memberships.
--
-- 1. event_funnel_prepare_order accepts one validated code (was rejected).
-- 2. event_funnel_discount_ready() enables the checkout field.
-- 3. Usage is counted once, when the order is confirmed (idempotent per order).
-- Install manually after review; automatic migrations remain disabled.

BEGIN;

CREATE OR REPLACE FUNCTION public.event_funnel_prepare_order(p_tenant uuid, p_id uuid, p_member uuid, p_capability_hash text, p_expected_revision integer, p_snapshot jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE s public.event_funnel_session; o public.event_funnel_order; h public.event_funnel_hold; line jsonb;
  total bigint:=0; training bigint:=0; vouchers bigint:=0; g jsonb; method text; currency text; ev record;
  disc jsonb; dc public.discount_code; m public.member; usage_count numeric; discounted bigint:=0; line_discount bigint;
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
    OR (coalesce((p_snapshot->>'trainingFundMinor')::bigint,0)<>0 AND NOT public.event_funnel_training_ready()) THEN
    RAISE EXCEPTION 'Aggregate funding reservation is not installed' USING ERRCODE='PT409';
  END IF;
  -- One discount code, on source (entry) event lines only. Re-check the code's
  -- current eligibility here; usage is counted only on confirmation.
  IF jsonb_typeof(coalesce(p_snapshot->'discounts','[]')) IS DISTINCT FROM 'array'
    OR jsonb_array_length(coalesce(p_snapshot->'discounts','[]'))>1 THEN
    RAISE EXCEPTION 'Only one discount code can be used' USING ERRCODE='22023';
  END IF;
  disc:=p_snapshot->'discounts'->0;
  IF disc IS NOT NULL THEN
    SELECT * INTO dc FROM public.discount_code WHERE tenant_id=p_tenant AND id=(disc->>'discountCodeId')::uuid FOR SHARE;
    IF NOT FOUND OR dc.is_active IS NOT TRUE OR lower(dc.code) IS DISTINCT FROM lower(disc->>'code')
      OR (dc.expires_at IS NOT NULL AND dc.expires_at<=clock_timestamp())
      OR (dc.event_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.event_funnel_hold WHERE tenant_id=p_tenant
        AND session_id=p_id AND node_id=g->>'entry' AND event_id=dc.event_id)) THEN
      RAISE EXCEPTION 'Discount code is no longer available' USING ERRCODE='PT409';
    END IF;
    IF dc.organization_id IS NOT NULL OR dc.member_id IS NOT NULL OR dc.role_id IS NOT NULL OR dc.member_group_id IS NOT NULL THEN
      SELECT * INTO m FROM public.member WHERE tenant_id=p_tenant AND id=s.member_id;
      IF NOT FOUND OR (dc.organization_id IS NOT NULL AND dc.organization_id IS DISTINCT FROM m.organization_id)
        OR (dc.member_id IS NOT NULL AND dc.member_id<>m.id)
        OR (dc.role_id IS NOT NULL AND dc.role_id IS DISTINCT FROM m.role_id)
        OR (dc.member_group_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.member_group_assignment
          WHERE member_id=m.id AND group_id=dc.member_group_id)) THEN
        RAISE EXCEPTION 'Discount purchaser eligibility changed' USING ERRCODE='PT409';
      END IF;
    END IF;
    IF dc.max_usage_count IS NOT NULL AND dc.max_usage_count>0 THEN
      IF dc.member_id IS NOT NULL OR dc.role_id IS NOT NULL OR dc.member_group_id IS NOT NULL THEN
        SELECT max(u.usage_count) INTO usage_count FROM public.discount_code_usage u
          WHERE u.discount_code_id=dc.id AND u.member_id=m.id;
      ELSE usage_count:=dc.current_usage_count; END IF;
      IF coalesce(usage_count,0)>=dc.max_usage_count THEN
        RAISE EXCEPTION 'Discount code has reached maximum uses' USING ERRCODE='PT409';
      END IF;
    END IF;
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
    line_discount:=coalesce((line->>'discountMinor')::bigint,0);
    IF line_discount<0 OR (line_discount>0 AND (disc IS NULL OR line->>'nodeId' IS DISTINCT FROM g->>'entry'
        OR (dc.ticket_class_id IS NOT NULL AND line->>'ticketId' IS DISTINCT FROM dc.ticket_class_id::text)
        OR (line->>'listMinor')::bigint IS DISTINCT FROM (line->>'amountMinor')::bigint+line_discount)) THEN
      RAISE EXCEPTION 'Invalid discount allocation' USING ERRCODE='22023';
    END IF;
    discounted:=discounted+line_discount;
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
  IF discounted IS DISTINCT FROM coalesce((p_snapshot->>'discountMinor')::bigint,0)
    OR (disc IS NOT NULL AND (discounted<=0 OR discounted IS DISTINCT FROM (disc->>'discountMinor')::bigint)) THEN
    RAISE EXCEPTION 'Invalid discount allocation' USING ERRCODE='22023';
  END IF;
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
END $function$;


CREATE OR REPLACE FUNCTION public.event_funnel_discount_ready() RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT true $$;
REVOKE ALL ON FUNCTION public.event_funnel_discount_ready() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.event_funnel_discount_ready() TO service_role;

CREATE TABLE IF NOT EXISTS public.event_funnel_discount_redemption(
  order_id uuid PRIMARY KEY REFERENCES public.event_funnel_order(id),
  tenant_id uuid NOT NULL,
  discount_code_id uuid NOT NULL,
  member_id uuid,
  organization_id uuid,
  discount_minor bigint NOT NULL CHECK (discount_minor>0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
ALTER TABLE public.event_funnel_discount_redemption ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.event_funnel_discount_redemption FROM PUBLIC,anon,authenticated;
GRANT SELECT ON public.event_funnel_discount_redemption TO service_role;

-- Counted on confirmation only: payment is already verified, so a code that
-- reached its limit meanwhile is still recorded rather than failing the order.
CREATE OR REPLACE FUNCTION public.event_funnel_discount_redeem()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE disc jsonb; dc public.discount_code; s public.event_funnel_session; m public.member;
  targeted boolean; usage_id uuid; inserted uuid;
BEGIN
  IF NEW.state IS NOT DISTINCT FROM OLD.state OR NEW.state<>'confirmed' THEN RETURN NEW; END IF;
  disc:=NEW.snapshot->'discounts'->0;
  IF disc IS NULL THEN RETURN NEW; END IF;
  SELECT * INTO s FROM public.event_funnel_session WHERE tenant_id=NEW.tenant_id AND id=NEW.session_id;
  SELECT * INTO dc FROM public.discount_code WHERE tenant_id=NEW.tenant_id AND id=(disc->>'discountCodeId')::uuid FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Discount code unavailable' USING ERRCODE='PT409'; END IF;
  IF s.member_id IS NOT NULL THEN SELECT * INTO m FROM public.member WHERE tenant_id=NEW.tenant_id AND id=s.member_id; END IF;
  INSERT INTO public.event_funnel_discount_redemption(order_id,tenant_id,discount_code_id,member_id,organization_id,discount_minor)
    VALUES(NEW.id,NEW.tenant_id,dc.id,m.id,m.organization_id,(disc->>'discountMinor')::bigint)
    ON CONFLICT (order_id) DO NOTHING RETURNING order_id INTO inserted;
  IF inserted IS NULL THEN RETURN NEW; END IF;
  targeted:=dc.member_id IS NOT NULL OR dc.role_id IS NOT NULL OR dc.member_group_id IS NOT NULL;
  IF NOT targeted THEN
    UPDATE public.discount_code SET current_usage_count=coalesce(current_usage_count,0)+1 WHERE id=dc.id;
  END IF;
  IF targeted AND m.id IS NOT NULL THEN
    SELECT id INTO usage_id FROM public.discount_code_usage WHERE discount_code_id=dc.id AND member_id=m.id ORDER BY id LIMIT 1 FOR UPDATE;
  ELSIF NOT targeted AND m.organization_id IS NOT NULL THEN
    SELECT id INTO usage_id FROM public.discount_code_usage WHERE discount_code_id=dc.id
      AND organization_id=m.organization_id AND member_id IS NULL ORDER BY id LIMIT 1 FOR UPDATE;
  END IF;
  IF usage_id IS NOT NULL THEN
    UPDATE public.discount_code_usage SET usage_count=coalesce(usage_count,0)+1 WHERE id=usage_id;
  ELSIF (targeted AND m.id IS NOT NULL) OR (NOT targeted AND m.organization_id IS NOT NULL) THEN
    INSERT INTO public.discount_code_usage(tenant_id,discount_code_id,organization_id,member_id,usage_count)
      VALUES(NEW.tenant_id,dc.id,m.organization_id,CASE WHEN targeted THEN m.id END,1);
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.event_funnel_discount_redeem() FROM PUBLIC,anon,authenticated,service_role;
DROP TRIGGER IF EXISTS event_funnel_discount_redeem ON public.event_funnel_order;
CREATE TRIGGER event_funnel_discount_redeem AFTER UPDATE OF state ON public.event_funnel_order
  FOR EACH ROW EXECUTE FUNCTION public.event_funnel_discount_redeem();

COMMIT;
