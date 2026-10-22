-- Service-owned personal entitlements; organization purchase behavior is retained.
BEGIN;
-- Existing usage rows retain their organization. Personal discount usage needs
-- a member without an invented organization (DEST currently requires org).
ALTER TABLE public.discount_code_usage ALTER COLUMN organization_id DROP NOT NULL;
ALTER TABLE public.discount_code_usage ADD CONSTRAINT discount_usage_has_owner
  CHECK (num_nonnulls(organization_id,member_id)>=1) NOT VALID;
CREATE TABLE public.program_member_entitlement (
  tenant_id uuid NOT NULL REFERENCES public.tenant(id),
  member_id uuid NOT NULL REFERENCES public.member(id),
  program_tag text NOT NULL,
  balance numeric NOT NULL DEFAULT 0 CHECK (balance >= 0),
  PRIMARY KEY(tenant_id,member_id,program_tag)
);
ALTER TABLE public.program_member_entitlement ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.program_member_entitlement FROM PUBLIC,anon,authenticated;
GRANT ALL ON public.program_member_entitlement TO service_role;
CREATE POLICY program_member_entitlement_service ON public.program_member_entitlement TO service_role USING(true) WITH CHECK(true);
ALTER TABLE public.program_ticket_transaction ALTER COLUMN organization_id DROP NOT NULL;
ALTER TABLE public.program_ticket_transaction ADD COLUMN IF NOT EXISTS owner_member_id uuid REFERENCES public.member(id);
ALTER TABLE public.program_ticket_transaction ADD COLUMN IF NOT EXISTS program_tag text;
ALTER TABLE public.program_ticket_transaction ADD COLUMN IF NOT EXISTS cancellation_reason text;
-- NOT VALID preserves historical rows while requiring exact ownership on new writes.
ALTER TABLE public.program_ticket_transaction ADD CONSTRAINT program_transaction_owner
  CHECK (num_nonnulls(organization_id,owner_member_id)=1) NOT VALID;

CREATE FUNCTION public.guard_program_credit_owner() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE row_data jsonb:=to_jsonb(NEW); old_data jsonb;
 t uuid; member_owner uuid; org_owner uuid;
BEGIN
 IF TG_OP='UPDATE' THEN
   old_data:=to_jsonb(OLD);
   IF row_data->'tenant_id' IS DISTINCT FROM old_data->'tenant_id'
     OR row_data->'organization_id' IS DISTINCT FROM old_data->'organization_id'
     OR row_data->'owner_member_id' IS DISTINCT FROM old_data->'owner_member_id'
     OR row_data->'member_id' IS DISTINCT FROM old_data->'member_id' THEN
     RAISE EXCEPTION 'Programme credit ownership is immutable';
   END IF;
   RETURN NEW;
 END IF;
 t:=(row_data->>'tenant_id')::uuid;
 org_owner:=(row_data->>'organization_id')::uuid;
 member_owner:=coalesce(row_data->>'owner_member_id',row_data->>'member_id')::uuid;
 IF t IS NULL OR num_nonnulls(org_owner,member_owner)<>1 THEN RAISE EXCEPTION 'Programme credit requires exactly one tenant-valid owner'; END IF;
 IF org_owner IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.organization WHERE id=org_owner AND tenant_id=t) THEN
   RAISE EXCEPTION 'Programme organization is outside tenant';
 END IF;
 IF member_owner IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.member WHERE id=member_owner AND tenant_id=t) THEN
   RAISE EXCEPTION 'Programme member is outside tenant';
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.guard_program_credit_owner() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.guard_program_credit_owner() TO service_role;
CREATE TRIGGER guard_program_entitlement_owner BEFORE INSERT OR UPDATE ON public.program_member_entitlement
 FOR EACH ROW EXECUTE FUNCTION public.guard_program_credit_owner();
CREATE TRIGGER guard_program_transaction_owner BEFORE INSERT OR UPDATE ON public.program_ticket_transaction
 FOR EACH ROW EXECUTE FUNCTION public.guard_program_credit_owner();

ALTER FUNCTION public.complete_program_credit_purchase(uuid,text,jsonb,text,text,text)
  RENAME TO complete_organization_program_credit_purchase;
CREATE FUNCTION public.complete_program_credit_purchase(
  p_tenant_id uuid,p_purchase_key text,p_quote jsonb,p_payment_method text,
  p_payment_intent_id text,p_purchase_order text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE m public.member%ROWTYPE; existing public.program_credit_purchase%ROWTYPE;
  allocation jsonb; ids uuid[]; n numeric; tx uuid; result jsonb;
  discount public.discount_code%ROWTYPE; usage public.discount_code_usage%ROWTYPE; targeted boolean;
BEGIN
  IF p_quote->>'organizationId' IS NOT NULL THEN
    RETURN public.complete_organization_program_credit_purchase(p_tenant_id,p_purchase_key,p_quote,p_payment_method,p_payment_intent_id,p_purchase_order);
  END IF;
  IF p_tenant_id IS NULL OR (p_quote->>'tenantId')::uuid IS DISTINCT FROM p_tenant_id
    OR coalesce(length(p_purchase_key),0) NOT BETWEEN 1 AND 200
    OR p_payment_method NOT IN ('card','account')
    OR coalesce((p_quote->>'tickets')::numeric,0)<=0
    OR coalesce(p_quote->>'programTag','')='' THEN RAISE EXCEPTION 'Invalid programme purchase'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(p_tenant_id::text||':'||p_purchase_key,0));
  SELECT * INTO existing FROM public.program_credit_purchase WHERE tenant_id=p_tenant_id AND purchase_key=p_purchase_key;
  IF FOUND THEN
    IF existing.binding IS DISTINCT FROM p_quote->>'binding' THEN RAISE EXCEPTION 'Purchase request changed'; END IF;
    RETURN existing.result;
  END IF;
  SELECT * INTO STRICT m FROM public.member WHERE tenant_id=p_tenant_id AND id=(p_quote->>'memberId')::uuid FOR UPDATE;
  IF m.organization_id IS NOT NULL THEN RAISE EXCEPTION 'Entitlement owner changed'; END IF;
  IF (p_quote->>'trainingFundMinor')::numeric<>0 THEN RAISE EXCEPTION 'Personal purchases cannot use training funds'; END IF;
  IF (p_quote->>'remainingMinor')::numeric>0 AND
    (p_payment_method<>'card' OR p_payment_intent_id IS NULL) THEN
    RAISE EXCEPTION 'Personal purchases require verified card payment for the remaining amount';
  END IF;
  IF p_quote->>'discountId' IS NOT NULL THEN
    SELECT * INTO STRICT discount FROM public.discount_code WHERE tenant_id=p_tenant_id AND id=(p_quote->>'discountId')::uuid FOR UPDATE;
    targeted := discount.member_id IS NOT NULL OR discount.role_id IS NOT NULL OR discount.member_group_id IS NOT NULL;
    IF targeted THEN
      SELECT * INTO usage FROM public.discount_code_usage WHERE discount_code_id=discount.id AND member_id=m.id FOR UPDATE;
    END IF;
    IF NOT discount.is_active OR discount.expires_at<=now() OR discount.organization_id IS NOT NULL
      OR (discount.member_id IS NOT NULL AND discount.member_id<>m.id)
      OR (discount.max_usage_count IS NOT NULL AND
        CASE WHEN targeted THEN coalesce(usage.usage_count,0) ELSE coalesce(discount.current_usage_count,0) END>=discount.max_usage_count)
      THEN RAISE EXCEPTION 'Discount is no longer available'; END IF;
    IF targeted THEN
      IF usage.id IS NULL THEN
        INSERT INTO public.discount_code_usage(tenant_id,discount_code_id,member_id,usage_count) VALUES(p_tenant_id,discount.id,m.id,1);
      ELSE UPDATE public.discount_code_usage SET usage_count=usage_count+1 WHERE id=usage.id; END IF;
    ELSE UPDATE public.discount_code SET current_usage_count=coalesce(current_usage_count,0)+1 WHERE id=discount.id; END IF;
  END IF;
  SELECT coalesce(array_agg(value::uuid),'{}'::uuid[]) INTO ids FROM jsonb_array_elements_text(p_quote->'voucherIds');
  IF cardinality(ids)>0 THEN
    allocation:=public.voucher_credit_reserve(p_tenant_id,p_purchase_key,m.id,m.id,ids,
      (p_quote->>'totalMinor')::bigint,'GBP',true,(p_quote->>'manualOrder')::boolean);
    IF (allocation->>'voucherMinor')::bigint<>(p_quote->>'voucherMinor')::bigint THEN RAISE EXCEPTION 'Credit balance changed'; END IF;
    PERFORM public.voucher_credit_transition(p_tenant_id,p_purchase_key,'commit',NULL);
  END IF;
  INSERT INTO public.program_member_entitlement(tenant_id,member_id,program_tag,balance)
    VALUES(p_tenant_id,m.id,p_quote->>'programTag',(p_quote->>'tickets')::numeric)
    ON CONFLICT(tenant_id,member_id,program_tag) DO UPDATE
    SET balance=program_member_entitlement.balance+excluded.balance RETURNING balance INTO n;
  INSERT INTO public.program_ticket_transaction(tenant_id,owner_member_id,program_tag,program_name,transaction_type,
    quantity,member_email,payment_method,stripe_payment_intent_id,booking_reference,
    discount_code_id,discount_amount_applied,total_cost_before_discount,notes,cash_amount,voucher_amount,training_fund_amount)
  VALUES(p_tenant_id,m.id,p_quote->>'programTag',p_quote->>'programName','purchase',(p_quote->>'tickets')::numeric,
    m.email,p_payment_method,p_payment_intent_id,p_purchase_key,(p_quote->>'discountId')::uuid,
    (p_quote->>'discountMinor')::numeric/100,(p_quote->>'grossMinor')::numeric/100,'Personal programme purchase',
    (p_quote->>'remainingMinor')::numeric/100,(p_quote->>'voucherMinor')::numeric/100,0)
  RETURNING id INTO tx;
  result:=jsonb_build_object('success',true,'transaction_id',tx,'new_balance',n,'member_id',m.id,'credit',allocation);
  INSERT INTO public.program_credit_purchase(tenant_id,purchase_key,binding,result)
    VALUES(p_tenant_id,p_purchase_key,p_quote->>'binding',result);
  RETURN result;
END $$;
REVOKE ALL ON FUNCTION public.complete_program_credit_purchase(uuid,text,jsonb,text,text,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.complete_program_credit_purchase(uuid,text,jsonb,text,text,text) TO service_role;

-- Booking rows, usage ledger and entitlement decrement share one transaction.
CREATE TABLE public.program_registration_attempt (
  tenant_id uuid NOT NULL REFERENCES public.tenant(id),
  attempt_id uuid NOT NULL,
  member_id uuid NOT NULL REFERENCES public.member(id),
  fingerprint text NOT NULL,
  request_hash text NOT NULL,
  result jsonb NOT NULL,
  PRIMARY KEY(tenant_id,attempt_id)
);
ALTER TABLE public.program_registration_attempt ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.program_registration_attempt FROM PUBLIC,anon,authenticated;
GRANT ALL ON public.program_registration_attempt TO service_role;
CREATE POLICY program_registration_attempt_service ON public.program_registration_attempt TO service_role USING(true) WITH CHECK(true);
ALTER TABLE public.booking ADD COLUMN IF NOT EXISTS organization_id uuid;
ALTER TABLE public.booking ADD COLUMN program_entitlement_transaction_id uuid REFERENCES public.program_ticket_transaction(id);
ALTER TABLE public.booking ADD COLUMN program_entitlement_refunded_at timestamptz;

CREATE FUNCTION public.guard_program_booking_provenance() RETURNS trigger
LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
  IF current_user IN ('anon','authenticated') THEN
    IF TG_OP='INSERT' THEN
      IF NEW.program_entitlement_transaction_id IS NOT NULL OR NEW.program_entitlement_refunded_at IS NOT NULL THEN
        RAISE EXCEPTION 'Programme booking provenance is service-owned';
      END IF;
    ELSIF NEW.program_entitlement_transaction_id IS DISTINCT FROM OLD.program_entitlement_transaction_id
      OR NEW.program_entitlement_refunded_at IS DISTINCT FROM OLD.program_entitlement_refunded_at THEN
      RAISE EXCEPTION 'Programme booking provenance is service-owned';
    END IF;
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.guard_program_booking_provenance() FROM PUBLIC,anon,authenticated;
CREATE TRIGGER guard_program_booking_provenance BEFORE INSERT OR UPDATE ON public.booking
  FOR EACH ROW EXECUTE FUNCTION public.guard_program_booking_provenance();

CREATE FUNCTION public.consume_program_entitlement(p_tenant_id uuid,p_member_id uuid,p_event_id uuid,p_reference text,p_bookings jsonb,
  p_attempt_id uuid,p_fingerprint text,p_owner_type text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE m public.member%ROWTYPE; e public.event%ROWTYPE; o public.organization%ROWTYPE;
  n numeric; qty integer; item jsonb; b public.booking%ROWTYPE; rows jsonb:='[]'; tx uuid; columns_sql text;
  attempt public.program_registration_attempt%ROWTYPE; result jsonb; request_hash text;
BEGIN
  IF p_attempt_id IS NULL OR coalesce(length(p_fingerprint),0)<>64 OR p_owner_type IS NULL OR p_owner_type NOT IN ('member','organization')
    THEN RAISE EXCEPTION 'Invalid programme registration attempt'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(p_tenant_id::text||':program-registration:'||p_attempt_id::text,0));
  SELECT encode(sha256(convert_to(jsonb_build_object('member',p_member_id,'event',p_event_id,'owner',p_owner_type,
    'reference',p_reference,'bookings',coalesce(jsonb_agg(value - ARRAY['id','created_at','zoom_registrant_id','confirmation_token','status','ticket_price']), '[]'::jsonb))::text,'UTF8')),'hex')
    INTO request_hash FROM jsonb_array_elements(p_bookings);
  SELECT * INTO attempt FROM public.program_registration_attempt WHERE tenant_id=p_tenant_id AND attempt_id=p_attempt_id;
  IF FOUND THEN
    IF attempt.member_id<>p_member_id OR attempt.fingerprint<>p_fingerprint OR attempt.request_hash<>request_hash
      THEN RAISE EXCEPTION 'Programme registration attempt changed'; END IF;
    RETURN attempt.result||jsonb_build_object('replayed',true);
  END IF;
  SELECT * INTO STRICT m FROM public.member WHERE tenant_id=p_tenant_id AND id=p_member_id FOR UPDATE;
  SELECT * INTO STRICT e FROM public.event WHERE tenant_id=p_tenant_id AND id=p_event_id FOR UPDATE;
  qty:=jsonb_array_length(p_bookings);
  IF qty<1 OR qty>10000 OR e.program_tag IS NULL OR e.status IN ('closed','cancelling')
    OR e.event_state='closed' OR e.registration_closes_at<now() THEN RAISE EXCEPTION 'Programme booking unavailable'; END IF;
  IF p_owner_type='member' THEN
    UPDATE public.program_member_entitlement SET balance=balance-qty
      WHERE tenant_id=p_tenant_id AND member_id=m.id AND program_tag=e.program_tag AND balance>=qty RETURNING balance INTO n;
    IF NOT FOUND THEN RAISE EXCEPTION 'Insufficient personal programme tickets'; END IF;
  ELSE
    IF m.organization_id IS NULL THEN RAISE EXCEPTION 'Organisation entitlement unavailable'; END IF;
    SELECT * INTO STRICT o FROM public.organization WHERE tenant_id=p_tenant_id AND id=m.organization_id FOR UPDATE;
    n:=coalesce((o.program_ticket_balances->>e.program_tag)::numeric,0)-qty;
    IF n<0 THEN RAISE EXCEPTION 'Insufficient programme tickets'; END IF;
    UPDATE public.organization SET program_ticket_balances=jsonb_set(coalesce(program_ticket_balances,'{}'),ARRAY[e.program_tag],to_jsonb(n)) WHERE id=o.id;
  END IF;
  INSERT INTO public.program_ticket_transaction(tenant_id,organization_id,owner_member_id,program_tag,program_name,transaction_type,quantity,booking_reference,member_email)
  VALUES(p_tenant_id,o.id,CASE WHEN o.id IS NULL THEN m.id END,e.program_tag,e.program_tag,'usage',qty,p_reference,m.email) RETURNING id INTO tx;
  FOR item IN SELECT value FROM jsonb_array_elements(p_bookings) LOOP
    item:=item||jsonb_build_object('id',gen_random_uuid(),'tenant_id',p_tenant_id,'member_id',m.id,
      'event_id',e.id,'payment_method','program_ticket','booking_group_reference',p_reference,
      'organization_id',o.id,'program_entitlement_transaction_id',tx,'program_entitlement_refunded_at',NULL);
    SELECT string_agg(quote_ident(key),',') INTO columns_sql FROM jsonb_object_keys(item) AS keys(key);
    -- Only supplied columns participate, so all other booking defaults are preserved.
    EXECUTE format('INSERT INTO public.booking (%s) SELECT %s FROM jsonb_populate_record(NULL::public.booking,$1) RETURNING *',
      columns_sql,columns_sql) INTO b USING item;
    rows:=rows||jsonb_build_array(to_jsonb(b));
  END LOOP;
  result:=jsonb_build_object('bookings',rows,'new_balance',n,'transaction_id',tx);
  INSERT INTO public.program_registration_attempt VALUES(p_tenant_id,p_attempt_id,p_member_id,p_fingerprint,request_hash,result);
  RETURN result;
END $$;
REVOKE ALL ON FUNCTION public.consume_program_entitlement(uuid,uuid,uuid,text,jsonb,uuid,text,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.consume_program_entitlement(uuid,uuid,uuid,text,jsonb,uuid,text,text) TO service_role;

-- Any existing cancellation entry point updating booking.status participates.
-- Provenance is immutable: neither the member's current org nor current event tag
-- decides the owner or programme restored.
CREATE FUNCTION public.restore_program_booking_entitlement(p_tenant_id uuid,p_booking_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE b public.booking%ROWTYPE; t public.program_ticket_transaction%ROWTYPE; n numeric;
BEGIN
  SELECT * INTO STRICT b FROM public.booking WHERE tenant_id=p_tenant_id AND id=p_booking_id FOR UPDATE;
  IF b.program_entitlement_transaction_id IS NULL THEN RETURN jsonb_build_object('handled',false); END IF;
  IF b.status IS DISTINCT FROM 'cancelled' THEN RAISE EXCEPTION 'Programme booking must be cancelled before restoration'; END IF;
  IF b.program_entitlement_refunded_at IS NOT NULL THEN RETURN jsonb_build_object('handled',true,'success',true,'already_refunded',true); END IF;
  SELECT * INTO STRICT t FROM public.program_ticket_transaction WHERE tenant_id=p_tenant_id AND id=b.program_entitlement_transaction_id FOR UPDATE;
  IF t.transaction_type<>'usage' THEN RAISE EXCEPTION 'Invalid programme entitlement provenance'; END IF;
  IF t.owner_member_id IS NOT NULL THEN
    UPDATE public.program_member_entitlement SET balance=balance+1
      WHERE tenant_id=p_tenant_id AND member_id=t.owner_member_id AND program_tag=t.program_tag RETURNING balance INTO n;
  ELSE
    UPDATE public.organization SET program_ticket_balances=jsonb_set(coalesce(program_ticket_balances,'{}'),ARRAY[t.program_tag],
      to_jsonb(coalesce((program_ticket_balances->>t.program_tag)::numeric,0)+1))
      WHERE tenant_id=p_tenant_id AND id=t.organization_id RETURNING (program_ticket_balances->>t.program_tag)::numeric INTO n;
  END IF;
  IF NOT FOUND THEN RAISE EXCEPTION 'Original entitlement owner unavailable'; END IF;
  UPDATE public.booking SET program_entitlement_refunded_at=now() WHERE id=b.id;
  INSERT INTO public.program_ticket_transaction(tenant_id,organization_id,owner_member_id,program_tag,program_name,transaction_type,quantity,member_email,booking_reference,notes)
    VALUES(p_tenant_id,t.organization_id,t.owner_member_id,t.program_tag,t.program_name,'refund',1,t.member_email,b.booking_reference,'Programme booking reversal '||b.id::text);
  IF NOT EXISTS(SELECT 1 FROM public.booking WHERE program_entitlement_transaction_id=t.id AND program_entitlement_refunded_at IS NULL) THEN
    UPDATE public.program_ticket_transaction SET cancelled_at=now() WHERE id=t.id;
  END IF;
  RETURN jsonb_build_object('handled',true,'success',true,'new_balance',n,'programTag',t.program_tag);
END $$;
REVOKE ALL ON FUNCTION public.restore_program_booking_entitlement(uuid,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.restore_program_booking_entitlement(uuid,uuid) TO service_role;

CREATE FUNCTION public.restore_cancelled_program_booking() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
  IF NEW.status='cancelled' AND OLD.status IS DISTINCT FROM 'cancelled' AND NEW.program_entitlement_transaction_id IS NOT NULL THEN
    PERFORM public.restore_program_booking_entitlement(NEW.tenant_id,NEW.id);
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.restore_cancelled_program_booking() FROM PUBLIC,anon,authenticated;
CREATE TRIGGER restore_cancelled_program_booking AFTER UPDATE OF status ON public.booking
  FOR EACH ROW EXECUTE FUNCTION public.restore_cancelled_program_booking();

CREATE FUNCTION public.cancel_program_entitlement_usage(p_tenant_id uuid,p_member_id uuid,p_transaction_id uuid,p_reason text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE m public.member%ROWTYPE; t public.program_ticket_transaction%ROWTYPE; n numeric; tag text;
BEGIN
  SELECT * INTO STRICT m FROM public.member WHERE tenant_id=p_tenant_id AND id=p_member_id;
  -- Lock bookings before the usage row, matching individual cancellation order.
  PERFORM 1 FROM public.booking WHERE tenant_id=p_tenant_id AND program_entitlement_transaction_id=p_transaction_id ORDER BY id FOR UPDATE;
  SELECT * INTO STRICT t FROM public.program_ticket_transaction WHERE tenant_id=p_tenant_id AND id=p_transaction_id FOR UPDATE;
  IF t.transaction_type<>'usage' OR
    (t.owner_member_id IS NOT NULL AND t.owner_member_id<>m.id) OR
    (t.organization_id IS NOT NULL AND t.organization_id IS DISTINCT FROM m.organization_id)
    THEN RAISE EXCEPTION 'Programme transaction is not accessible'; END IF;
  IF t.cancelled_at IS NOT NULL THEN RETURN jsonb_build_object('success',true,'already_cancelled',true); END IF;
  IF EXISTS(SELECT 1 FROM public.booking WHERE tenant_id=p_tenant_id AND program_entitlement_transaction_id=t.id) THEN
    UPDATE public.booking SET status='cancelled' WHERE tenant_id=p_tenant_id AND program_entitlement_transaction_id=t.id AND status IS DISTINCT FROM 'cancelled';
    -- Covers retry of a cancellation whose booking status was already persisted.
    PERFORM public.restore_program_booking_entitlement(p_tenant_id,id) FROM public.booking
      WHERE tenant_id=p_tenant_id AND program_entitlement_transaction_id=t.id;
    UPDATE public.program_ticket_transaction SET cancelled_at=now(),cancelled_by_member_email=m.email,cancellation_reason=p_reason WHERE id=t.id;
    RETURN jsonb_build_object('success',true,'refunded_quantity',t.quantity);
  END IF;
  tag:=coalesce(t.program_tag,t.program_name);
  IF t.owner_member_id IS NOT NULL THEN
    UPDATE public.program_member_entitlement SET balance=balance+t.quantity
      WHERE tenant_id=p_tenant_id AND member_id=t.owner_member_id AND program_tag=tag RETURNING balance INTO n;
  ELSE
    UPDATE public.organization SET program_ticket_balances=jsonb_set(coalesce(program_ticket_balances,'{}'),ARRAY[tag],
      to_jsonb(coalesce((program_ticket_balances->>tag)::numeric,0)+t.quantity))
      WHERE tenant_id=p_tenant_id AND id=t.organization_id RETURNING (program_ticket_balances->>tag)::numeric INTO n;
  END IF;
  IF NOT FOUND THEN RAISE EXCEPTION 'Original entitlement owner unavailable'; END IF;
  UPDATE public.program_ticket_transaction SET cancelled_at=now(),cancelled_by_member_email=m.email,cancellation_reason=p_reason WHERE id=t.id;
  UPDATE public.booking SET status='cancelled' WHERE tenant_id=p_tenant_id AND booking_group_reference=t.booking_reference AND payment_method='program_ticket';
  INSERT INTO public.program_ticket_transaction(tenant_id,organization_id,owner_member_id,program_tag,program_name,transaction_type,quantity,member_email,notes)
    VALUES(p_tenant_id,t.organization_id,t.owner_member_id,tag,t.program_name,'refund',t.quantity,m.email,'Reversal of '||t.id::text);
  RETURN jsonb_build_object('success',true,'refunded_quantity',t.quantity,'new_balance',n);
END $$;
REVOKE ALL ON FUNCTION public.cancel_program_entitlement_usage(uuid,uuid,uuid,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.cancel_program_entitlement_usage(uuid,uuid,uuid,text) TO service_role;
COMMIT;
