-- Prepared only: installation requires separate destination approval.
-- Bundle counters remain the existing form_bundle_stock authority. Component
-- products are checked for unsupported fulfilment, never allocated by bundles.
BEGIN;

CREATE TABLE public.form_product_stock (
  tenant_id uuid NOT NULL,
  product_id uuid NOT NULL,
  remaining integer CHECK (remaining IS NULL OR remaining >= 0),
  reserved integer NOT NULL DEFAULT 0 CHECK (reserved >= 0),
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, product_id),
  FOREIGN KEY (tenant_id, product_id) REFERENCES public.sales_catalogue_product(tenant_id,id) ON DELETE RESTRICT
);
CREATE TABLE public.form_cart_receipt (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  submission_id uuid NOT NULL UNIQUE REFERENCES public.form_submission(id) ON DELETE RESTRICT,
  field_id text NOT NULL,
  answer jsonb NOT NULL,
  terms jsonb NOT NULL,
  state text NOT NULL DEFAULT 'held' CHECK (state IN ('held','consumed','released')),
  release_evidence jsonb,
  next_check_at timestamptz NOT NULL DEFAULT now() + interval '24 hours',
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  finalized_at timestamptz,
  CHECK ((state='held' AND finalized_at IS NULL AND release_evidence IS NULL)
    OR (state='consumed' AND finalized_at IS NOT NULL AND release_evidence IS NULL)
    OR (state='released' AND finalized_at IS NOT NULL AND release_evidence IS NOT NULL))
);
CREATE INDEX form_cart_receipt_cleanup ON public.form_cart_receipt(next_check_at,id) WHERE state='held';

CREATE FUNCTION public.guard_form_cart_receipt() RETURNS trigger
LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Cart evidence cannot be deleted' USING ERRCODE='23514'; END IF;
  IF (to_jsonb(NEW)-ARRAY['state','release_evidence','finalized_at','next_check_at','last_error'])
    IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['state','release_evidence','finalized_at','next_check_at','last_error'])
    OR OLD.state<>'held' THEN
    RAISE EXCEPTION 'Cart receipt is immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER form_cart_receipt_immutable BEFORE UPDATE OR DELETE ON public.form_cart_receipt
  FOR EACH ROW EXECUTE FUNCTION public.guard_form_cart_receipt();

CREATE FUNCTION public.set_form_product_stock(
  p_tenant_id uuid,p_product_id uuid,p_expected_version bigint,p_remaining integer,p_actor_id text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE s public.form_product_stock; before_value jsonb;
BEGIN
  IF p_remaining<0 OR p_expected_version IS NULL OR p_expected_version<0
    OR p_actor_id IS NULL OR length(btrim(p_actor_id))=0 THEN
    RAISE EXCEPTION 'Invalid product stock edit' USING ERRCODE='22023';
  END IF;
  PERFORM 1 FROM public.sales_catalogue_product WHERE tenant_id=p_tenant_id AND id=p_product_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Product not found' USING ERRCODE='P0002'; END IF;
  SELECT * INTO s FROM public.form_product_stock WHERE tenant_id=p_tenant_id AND product_id=p_product_id FOR UPDATE;
  before_value:=to_jsonb(s);
  IF NOT FOUND THEN
    IF p_expected_version<>0 THEN RAISE EXCEPTION 'Stock changed; reload and retry' USING ERRCODE='40001'; END IF;
    INSERT INTO public.form_product_stock(tenant_id,product_id,remaining)
      VALUES(p_tenant_id,p_product_id,p_remaining) RETURNING * INTO s;
  ELSE
    IF s.version<>p_expected_version THEN RAISE EXCEPTION 'Stock changed; reload and retry' USING ERRCODE='40001'; END IF;
    IF s.reserved>0 AND (s.remaining IS NULL)<>(p_remaining IS NULL) THEN
      RAISE EXCEPTION 'Resolve existing holds before changing Unlimited mode' USING ERRCODE='22023';
    END IF;
    UPDATE public.form_product_stock SET remaining=p_remaining,version=version+1,updated_at=now()
      WHERE tenant_id=p_tenant_id AND product_id=p_product_id RETURNING * INTO s;
  END IF;
  INSERT INTO public.sales_audit_event(tenant_id,actor_id,actor_type,action,entity_type,entity_id,before_data,after_data)
    VALUES(p_tenant_id,p_actor_id,'tenant_user','product.stock_updated','sales_catalogue_product',
      p_product_id::text,before_value,to_jsonb(s));
  RETURN to_jsonb(s);
END;
$$;

-- Called by the shared submission INSERT trigger, so failure rolls back both
-- submission persistence and every stock deduction, including earlier lines.
CREATE FUNCTION public.reserve_form_cart(p_tenant_id uuid,p_submission_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE submission public.form_submission; f public.form; field jsonb; payment jsonb;
  a public.form_cart_receipt; answer jsonb; line jsonb; item jsonb; tax jsonb;
  lines jsonb:='[]'; normalized jsonb:='[]'; terms jsonb; kind text; item_id uuid;
  qty integer; available integer; held integer; unit_price bigint; rate integer;
  treatment text; net numeric; vat numeric; total_net numeric:=0; total_tax numeric:=0;
  currency text; finite boolean;
BEGIN
  SELECT * INTO submission FROM public.form_submission WHERE tenant_id=p_tenant_id AND id=p_submission_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Submission not found' USING ERRCODE='P0002'; END IF;
  SELECT * INTO a FROM public.form_cart_receipt WHERE submission_id=p_submission_id;
  IF FOUND THEN RETURN a.terms; END IF;
  SELECT * INTO f FROM public.form WHERE tenant_id=p_tenant_id AND id=submission.form_id FOR SHARE;
  SELECT value INTO field FROM jsonb_array_elements(f.fields) WHERE value->>'type'='sales_cart';
  IF field IS NULL THEN RETURN NULL; END IF;
  IF f.form_type IS NOT NULL AND f.form_type<>'standard'
    OR (SELECT count(*) FROM jsonb_array_elements(f.fields) WHERE value->>'type'='sales_cart')<>1
    OR field->>'cart_version' IS DISTINCT FROM '1'
    OR EXISTS(SELECT 1 FROM jsonb_array_elements(f.fields) WHERE value->>'type' IN ('sales_bundle','membership_payment'))
    OR (SELECT count(*) FROM jsonb_array_elements(f.fields) WHERE value->>'type'='payment')<>1 THEN
    RAISE EXCEPTION 'Unsupported cart configuration' USING ERRCODE='22023';
  END IF;
  SELECT value INTO payment FROM jsonb_array_elements(f.fields) WHERE value->>'type'='payment';
  IF payment->>'price_field_id' IS DISTINCT FROM field->>'id'
    OR payment->>'payment_mode'='monthly' OR payment->>'allow_monthly_payments'='true'
    OR payment->>'monthly_instalments'='true' THEN
    RAISE EXCEPTION 'Cart requires one-off Payment sourced from Cart total' USING ERRCODE='22023';
  END IF;
  IF submission.submission_data->>'__cart_hidden'=field->>'id' THEN RETURN NULL; END IF;
  answer:=submission.submission_data->(field->>'id');
  IF answer IS NULL OR answer='null'::jsonb OR answer='""'::jsonb THEN answer:='{"version":1,"lines":[]}'; END IF;
  IF answer->>'version' IS DISTINCT FROM '1' OR jsonb_typeof(answer->'lines') IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'Invalid cart answer' USING ERRCODE='22023';
  END IF;
  IF jsonb_array_length(answer->'lines')>100 THEN RAISE EXCEPTION 'Too many cart lines' USING ERRCODE='22023'; END IF;
  -- Validate before casts; aggregate duplicate identities, always lock in the
  -- same bundle-then-product order across simultaneous mixed carts.
  FOR line IN SELECT value FROM jsonb_array_elements(answer->'lines') LOOP
    IF COALESCE(line->>'kind','') NOT IN ('bundle','product')
      OR COALESCE(line->>'quantity','') !~ '^[0-9]+$'
      OR (line->>'quantity')::numeric NOT BETWEEN 1 AND 1000
      OR COALESCE(line->>'id','') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' THEN
      RAISE EXCEPTION 'Invalid cart line' USING ERRCODE='22023';
    END IF;
  END LOOP;
  currency:=upper(COALESCE(payment->>'payment_currency','GBP'));
  FOR line IN SELECT jsonb_build_object('kind',value->>'kind','id',lower(value->>'id'),
      'quantity',sum((value->>'quantity')::integer))
    FROM jsonb_array_elements(answer->'lines') GROUP BY value->>'kind',lower(value->>'id')
    ORDER BY value->>'kind',lower(value->>'id') LOOP
    kind:=line->>'kind'; item_id:=(line->>'id')::uuid; qty:=(line->>'quantity')::integer;
    IF qty>1000 OR NOT COALESCE(field->CASE WHEN kind='bundle' THEN 'allowed_bundle_ids' ELSE 'allowed_product_ids' END ? item_id::text,false) THEN
      RAISE EXCEPTION 'Cart item is not allowed' USING ERRCODE='22023';
    END IF;
    IF kind='bundle' THEN
      SELECT to_jsonb(b) INTO item FROM public.sales_catalogue_bundle b WHERE tenant_id=p_tenant_id AND id=item_id FOR UPDATE;
      -- Lock constituent products for eligibility only; never deduct them.
      PERFORM p.id FROM public.sales_catalogue_product p JOIN public.sales_catalogue_bundle_item bi
        ON bi.tenant_id=p.tenant_id AND bi.product_id=p.id
        WHERE bi.tenant_id=p_tenant_id AND bi.bundle_id=item_id ORDER BY p.id FOR SHARE OF p;
      IF EXISTS(SELECT 1 FROM public.sales_catalogue_bundle_item bi LEFT JOIN public.sales_catalogue_product p
        ON p.tenant_id=bi.tenant_id AND p.id=bi.product_id
        WHERE bi.tenant_id=p_tenant_id AND bi.bundle_id=item_id
          AND (p.id IS NULL OR p.event_reference_kind IS NOT NULL OR p.event_id IS NOT NULL
            OR p.ticket_type_id IS NOT NULL OR p.space_requirement_id IS NOT NULL)) THEN
        RAISE EXCEPTION 'Cart cannot fulfil event tickets or exhibition spaces' USING ERRCODE='22023';
      END IF;
      unit_price:=(item->>'selling_price_minor')::bigint;
      tax:=field->'bundle_tax'->item_id::text;
      treatment:=tax->>'treatment'; rate:=(tax->>'rateBps')::integer;
      INSERT INTO public.form_bundle_stock(tenant_id,bundle_id) VALUES(p_tenant_id,item_id) ON CONFLICT DO NOTHING;
      SELECT remaining,reserved INTO available,held FROM public.form_bundle_stock WHERE tenant_id=p_tenant_id AND bundle_id=item_id FOR UPDATE;
    ELSE
      SELECT to_jsonb(p) INTO item FROM public.sales_catalogue_product p WHERE tenant_id=p_tenant_id AND id=item_id FOR UPDATE;
      IF item->>'event_reference_kind' IS NOT NULL OR item->>'event_id' IS NOT NULL
        OR item->>'ticket_type_id' IS NOT NULL OR item->>'space_requirement_id' IS NOT NULL THEN
        RAISE EXCEPTION 'Cart cannot fulfil event tickets or exhibition spaces' USING ERRCODE='22023';
      END IF;
      unit_price:=(item->>'standard_price_minor')::bigint;
      treatment:=item->>'tax_treatment'; rate:=(item->>'tax_rate_bps')::integer;
      INSERT INTO public.form_product_stock(tenant_id,product_id) VALUES(p_tenant_id,item_id) ON CONFLICT DO NOTHING;
      SELECT remaining,reserved INTO available,held FROM public.form_product_stock WHERE tenant_id=p_tenant_id AND product_id=item_id FOR UPDATE;
    END IF;
    IF item IS NULL OR item->>'is_active' IS DISTINCT FROM 'true' OR item->>'archived_at' IS NOT NULL
      OR (item->>'available_from')::timestamptz>now() OR (item->>'available_to')::timestamptz<now()
      OR item->>'currency' IS DISTINCT FROM currency THEN
      RAISE EXCEPTION 'Cart item is unavailable' USING ERRCODE='P0001';
    END IF;
    IF unit_price IS NULL OR unit_price<0 OR rate IS NULL OR rate NOT BETWEEN 0 AND 100000
      OR treatment IS NULL OR treatment NOT IN ('standard','zero_rated','exempt','outside_scope')
      OR (treatment<>'standard' AND rate<>0) THEN
      RAISE EXCEPTION 'Cart tax or price is ambiguous' USING ERRCODE='22023';
    END IF;
    IF available<qty THEN RAISE EXCEPTION 'Cart item has insufficient stock' USING ERRCODE='P0001'; END IF;
    finite:=available IS NOT NULL;
    net:=unit_price::numeric*qty; vat:=round(net*rate/10000);
    total_net:=total_net+net; total_tax:=total_tax+vat;
    IF total_net+total_tax>9007199254740991 THEN RAISE EXCEPTION 'Cart total too large' USING ERRCODE='22023'; END IF;
    lines:=lines||jsonb_build_array(line||jsonb_build_object('name',item->>'name','description',COALESCE(item->>'description',''),
      'unitPriceMinor',unit_price,'taxTreatment',treatment,'taxRateBps',rate,'currency',currency,
      'netMinor',net,'taxMinor',vat,'grossMinor',net+vat,'finite',finite));
    normalized:=normalized||jsonb_build_array(line);
    IF kind='bundle' THEN
      UPDATE public.form_bundle_stock SET remaining=remaining-qty,reserved=reserved+qty,version=version+1,updated_at=now()
        WHERE tenant_id=p_tenant_id AND bundle_id=item_id;
    ELSE
      UPDATE public.form_product_stock SET remaining=remaining-qty,reserved=reserved+qty,version=version+1,updated_at=now()
        WHERE tenant_id=p_tenant_id AND product_id=item_id;
    END IF;
  END LOOP;
  IF field->>'required'='true' AND jsonb_array_length(lines)=0 THEN
    RAISE EXCEPTION 'Choose at least one cart item' USING ERRCODE='22023';
  END IF;
  IF submission.payment_provider IS NOT NULL AND submission.payment_provider NOT IN ('stripe','gocardless')
    OR submission.payment_provider IS NULL AND total_net+total_tax>0
    OR submission.payment_provider IS NOT NULL AND (submission.payment_amount IS DISTINCT FROM (total_net+total_tax)/100
      OR upper(submission.payment_currency) IS DISTINCT FROM currency OR submission.payment_status IS DISTINCT FROM 'pending') THEN
    RAISE EXCEPTION 'Cart payment terms changed; request a new quote' USING ERRCODE='40001';
  END IF;
  terms:=jsonb_build_object('version',1,'fieldId',field->>'id','currency',currency,'lines',lines,
    'netMinor',total_net,'taxMinor',total_tax,'grossMinor',total_net+total_tax);
  INSERT INTO public.form_cart_receipt(tenant_id,submission_id,field_id,answer,terms)
    VALUES(p_tenant_id,p_submission_id,field->>'id',jsonb_build_object('version',1,'lines',normalized),terms);
  RETURN terms;
END;
$$;

CREATE FUNCTION public.finalize_form_cart(p_tenant_id uuid,p_submission_id uuid,p_state text,p_release_evidence jsonb DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE a public.form_cart_receipt; submission public.form_submission; line jsonb; qty integer;
BEGIN
  IF p_state IS NULL OR p_state NOT IN ('consumed','released') THEN RAISE EXCEPTION 'Invalid cart state' USING ERRCODE='22023'; END IF;
  SELECT * INTO submission FROM public.form_submission WHERE tenant_id=p_tenant_id AND id=p_submission_id FOR UPDATE;
  SELECT * INTO a FROM public.form_cart_receipt WHERE tenant_id=p_tenant_id AND submission_id=p_submission_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Cart receipt not found' USING ERRCODE='P0002'; END IF;
  IF a.state=p_state THEN RETURN a.terms; END IF;
  IF a.state<>'held' THEN RAISE EXCEPTION 'Cart allocation already finalized; requires attention' USING ERRCODE='23514'; END IF;
  IF p_state='consumed' AND submission.payment_provider IS NOT NULL AND submission.payment_status IS DISTINCT FROM 'paid' THEN
    RAISE EXCEPTION 'Authoritative payment success required' USING ERRCODE='22023';
  END IF;
  IF p_state='released' AND (
    p_release_evidence IS NULL OR jsonb_typeof(p_release_evidence)<>'object'
    OR COALESCE(p_release_evidence->>'provider','') NOT IN ('stripe','gocardless')
    OR COALESCE(p_release_evidence->>'terminal_status','') NOT IN ('cancelled','expired')
    OR COALESCE(length(p_release_evidence->>'reference'),0)=0
    OR COALESCE(length(p_release_evidence->>'verified_at'),0)=0
    OR p_release_evidence->>'provider' IS DISTINCT FROM submission.payment_provider
    OR p_release_evidence->>'reference' IS DISTINCT FROM submission.payment_reference
    OR submission.payment_status='paid') THEN
    RAISE EXCEPTION 'Verified terminal provider evidence required' USING ERRCODE='22023';
  END IF;
  FOR line IN SELECT value FROM jsonb_array_elements(a.terms->'lines') ORDER BY value->>'kind',value->>'id' LOOP
    qty:=(line->>'quantity')::integer;
    IF line->>'kind'='bundle' THEN
      UPDATE public.form_bundle_stock SET reserved=reserved-qty,
        remaining=CASE WHEN p_state='released' AND (line->>'finite')::boolean THEN remaining+qty ELSE remaining END,
        version=version+1,updated_at=now() WHERE tenant_id=p_tenant_id AND bundle_id=(line->>'id')::uuid;
    ELSE
      UPDATE public.form_product_stock SET reserved=reserved-qty,
        remaining=CASE WHEN p_state='released' AND (line->>'finite')::boolean THEN remaining+qty ELSE remaining END,
        version=version+1,updated_at=now() WHERE tenant_id=p_tenant_id AND product_id=(line->>'id')::uuid;
    END IF;
  END LOOP;
  UPDATE public.form_cart_receipt SET state=p_state,finalized_at=now(),
    release_evidence=CASE WHEN p_state='released' THEN p_release_evidence ELSE NULL END WHERE id=a.id;
  RETURN a.terms;
END;
$$;

CREATE FUNCTION public.allocate_submission_cart() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE terms jsonb; a public.form_cart_receipt;
BEGIN
  terms:=public.reserve_form_cart(NEW.tenant_id,NEW.id);
  IF terms IS NULL THEN RETURN NEW; END IF;
  SELECT * INTO a FROM public.form_cart_receipt WHERE submission_id=NEW.id;
  UPDATE public.form_submission SET submission_data=(submission_data-'__cart_receipt')
    ||jsonb_build_object('__cart_receipt',terms,a.field_id,a.answer) WHERE id=NEW.id;
  IF NEW.payment_provider IS NULL THEN PERFORM public.finalize_form_cart(NEW.tenant_id,NEW.id,'consumed'); END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER allocate_submission_cart AFTER INSERT ON public.form_submission
  FOR EACH ROW EXECUTE FUNCTION public.allocate_submission_cart();

CREATE FUNCTION public.guard_submission_cart() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE a public.form_cart_receipt;
BEGIN
  SELECT * INTO a FROM public.form_cart_receipt WHERE submission_id=OLD.id;
  IF NOT FOUND THEN RETURN NEW; END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
    OR NEW.form_id IS DISTINCT FROM OLD.form_id OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
    OR (NEW.submission_data-ARRAY['__cart_receipt',a.field_id]) IS DISTINCT FROM (OLD.submission_data-ARRAY['__cart_receipt',a.field_id])
    OR NEW.payment_amount IS DISTINCT FROM OLD.payment_amount OR NEW.payment_currency IS DISTINCT FROM OLD.payment_currency
    OR NEW.payment_provider IS DISTINCT FROM OLD.payment_provider
    OR (OLD.payment_reference IS NOT NULL AND NEW.payment_reference IS DISTINCT FROM OLD.payment_reference)
    OR (NEW.submission_data->a.field_id IS DISTINCT FROM OLD.submission_data->a.field_id
      AND NEW.submission_data->a.field_id IS DISTINCT FROM a.answer) THEN
    RAISE EXCEPTION 'Cart checkout terms and answers are immutable' USING ERRCODE='23514';
  END IF;
  NEW.submission_data:=(NEW.submission_data-'__cart_receipt')||jsonb_build_object('__cart_receipt',a.terms,a.field_id,a.answer);
  RETURN NEW;
END;
$$;
CREATE TRIGGER form_cart_submission_immutable BEFORE UPDATE ON public.form_submission
  FOR EACH ROW EXECUTE FUNCTION public.guard_submission_cart();
CREATE FUNCTION public.settle_submission_cart() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
  IF NEW.payment_status='paid' AND OLD.payment_status IS DISTINCT FROM 'paid'
    AND EXISTS(SELECT 1 FROM public.form_cart_receipt WHERE submission_id=NEW.id) THEN
    PERFORM public.finalize_form_cart(NEW.tenant_id,NEW.id,'consumed');
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER settle_submission_cart AFTER UPDATE ON public.form_submission
  FOR EACH ROW EXECUTE FUNCTION public.settle_submission_cart();
CREATE FUNCTION public.defer_form_cart_check(p_tenant_id uuid,p_submission_id uuid,p_error text)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path=public,pg_temp AS $$
  UPDATE public.form_cart_receipt SET next_check_at=now()+interval '1 hour',last_error=left(p_error,500)
    WHERE tenant_id=p_tenant_id AND submission_id=p_submission_id AND state='held';
$$;
CREATE FUNCTION public.form_cart_version() RETURNS integer LANGUAGE sql STABLE
SET search_path=public,pg_temp AS $$ SELECT 1; $$;

ALTER TABLE public.form_product_stock ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.form_cart_receipt ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.form_product_stock,public.form_cart_receipt FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.form_product_stock,public.form_cart_receipt TO service_role;
CREATE POLICY form_product_stock_read ON public.form_product_stock FOR SELECT TO service_role USING(true);
CREATE POLICY form_cart_receipt_read ON public.form_cart_receipt FOR SELECT TO service_role USING(true);
REVOKE ALL ON FUNCTION public.guard_form_cart_receipt(),public.allocate_submission_cart(),
  public.guard_submission_cart(),public.settle_submission_cart() FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.set_form_product_stock(uuid,uuid,bigint,integer,text),
  public.reserve_form_cart(uuid,uuid),public.finalize_form_cart(uuid,uuid,text,jsonb),
  public.defer_form_cart_check(uuid,uuid,text),public.form_cart_version() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.set_form_product_stock(uuid,uuid,bigint,integer,text),
  public.reserve_form_cart(uuid,uuid),public.finalize_form_cart(uuid,uuid,text,jsonb),
  public.defer_form_cart_check(uuid,uuid,text),public.form_cart_version() TO service_role;
COMMIT;
