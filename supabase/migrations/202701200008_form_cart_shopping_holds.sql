-- Apply after the matching client/API deployment, and after 202701200007.
-- Shopping reservations have a fixed, server-owned deadline. No submission
-- (and therefore no accounting or notification side effects) is created here.
BEGIN;
CREATE TABLE public.form_cart_hold (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  form_id uuid NOT NULL REFERENCES public.form(id),
  answer jsonb NOT NULL DEFAULT '{"version":1,"lines":[]}',
  expires_at timestamptz NOT NULL,
  state text NOT NULL DEFAULT 'shopping' CHECK (state IN ('shopping','checkout','released')),
  version bigint NOT NULL DEFAULT 0,
  submission_id uuid UNIQUE REFERENCES public.form_submission(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX form_cart_hold_expiry ON public.form_cart_hold(expires_at,id) WHERE state='shopping';
ALTER TABLE public.form_cart_hold ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.form_cart_hold FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.form_cart_hold TO service_role;
CREATE POLICY form_cart_hold_service_read ON public.form_cart_hold FOR SELECT TO service_role USING(true);

-- Internal only. Caller owns the hold lock. Always lock all stock identities
-- in the same order, including removed lines, before changing any counters.
CREATE FUNCTION public.replace_form_cart_hold_stock(p_tenant uuid,p_old jsonb,p_new jsonb)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE entry record; delta integer; remaining_count integer;
BEGIN
  FOR entry IN
    SELECT kind,id,sum(qty)::integer AS delta FROM (
      SELECT value->>'kind' kind,(value->>'id')::uuid id,-(value->>'quantity')::integer qty
        FROM jsonb_array_elements(p_old->'lines')
      UNION ALL
      SELECT value->>'kind',(value->>'id')::uuid,(value->>'quantity')::integer
        FROM jsonb_array_elements(p_new->'lines')
    ) x GROUP BY kind,id ORDER BY kind,id
  LOOP
    delta:=entry.delta;
    IF entry.kind='bundle' THEN
      PERFORM 1 FROM public.sales_catalogue_bundle WHERE tenant_id=p_tenant AND id=entry.id FOR UPDATE;
      IF NOT FOUND THEN RAISE EXCEPTION 'Cart item unavailable'; END IF;
      INSERT INTO public.form_bundle_stock(tenant_id,bundle_id) VALUES(p_tenant,entry.id) ON CONFLICT DO NOTHING;
      SELECT remaining INTO remaining_count FROM public.form_bundle_stock WHERE tenant_id=p_tenant AND bundle_id=entry.id FOR UPDATE;
      IF delta>0 AND remaining_count<delta THEN RAISE EXCEPTION 'Cart item has insufficient stock'; END IF;
      UPDATE public.form_bundle_stock SET remaining=remaining-delta,reserved=reserved+delta,version=version+1,updated_at=now()
        WHERE tenant_id=p_tenant AND bundle_id=entry.id;
    ELSE
      PERFORM 1 FROM public.sales_catalogue_product WHERE tenant_id=p_tenant AND id=entry.id FOR UPDATE;
      IF NOT FOUND THEN RAISE EXCEPTION 'Cart item unavailable'; END IF;
      INSERT INTO public.form_product_stock(tenant_id,product_id) VALUES(p_tenant,entry.id) ON CONFLICT DO NOTHING;
      SELECT remaining INTO remaining_count FROM public.form_product_stock WHERE tenant_id=p_tenant AND product_id=entry.id FOR UPDATE;
      IF delta>0 AND remaining_count<delta THEN RAISE EXCEPTION 'Cart item has insufficient stock'; END IF;
      UPDATE public.form_product_stock SET remaining=remaining-delta,reserved=reserved+delta,version=version+1,updated_at=now()
        WHERE tenant_id=p_tenant AND product_id=entry.id;
    END IF;
  END LOOP;
END;
$$;

CREATE FUNCTION public.update_form_cart_hold(p_tenant_id uuid,p_form_id uuid,p_id uuid,
  p_answer jsonb DEFAULT NULL,p_expected_version bigint DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE h public.form_cart_hold; fields jsonb; field jsonb; line jsonb; item jsonb;
  normalized jsonb; duration integer; receipt_state text; maximum integer;
BEGIN
  SELECT f.fields INTO fields FROM public.form f WHERE f.id=p_form_id AND f.tenant_id=p_tenant_id FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Form unavailable'; END IF;
  SELECT value INTO field FROM jsonb_array_elements(fields) WHERE value->>'type'='sales_cart';
  IF field IS NULL THEN RAISE EXCEPTION 'Cart unavailable'; END IF;
  SELECT * INTO h FROM public.form_cart_hold WHERE id=p_id FOR UPDATE;
  IF FOUND AND (h.tenant_id<>p_tenant_id OR h.form_id<>p_form_id) THEN RAISE EXCEPTION 'Reservation unavailable'; END IF;
  IF NOT FOUND THEN
    IF p_answer IS NULL THEN RETURN jsonb_build_object('state','missing','serverNow',now()); END IF;
    duration:=COALESCE((field->>'reservation_minutes')::integer,5);
    IF duration NOT BETWEEN 1 AND 60 THEN RAISE EXCEPTION 'Reservation duration must be 1 to 60 minutes'; END IF;
    INSERT INTO public.form_cart_hold(id,tenant_id,form_id,expires_at)
      VALUES(p_id,p_tenant_id,p_form_id,now()+make_interval(mins=>duration)) ON CONFLICT DO NOTHING;
    SELECT * INTO h FROM public.form_cart_hold WHERE id=p_id FOR UPDATE;
    IF h.tenant_id<>p_tenant_id OR h.form_id<>p_form_id THEN RAISE EXCEPTION 'Reservation unavailable'; END IF;
  END IF;
  IF h.state='shopping' AND h.expires_at<=now() THEN
    PERFORM public.replace_form_cart_hold_stock(p_tenant_id,h.answer,'{"version":1,"lines":[]}');
    UPDATE public.form_cart_hold SET state='released',version=version+1 WHERE id=p_id RETURNING * INTO h;
  END IF;
  IF h.state='shopping' AND p_answer IS NOT NULL THEN
    IF p_answer->>'version' IS DISTINCT FROM '1' OR jsonb_typeof(p_answer->'lines') IS DISTINCT FROM 'array'
      OR jsonb_array_length(p_answer->'lines')>100 THEN RAISE EXCEPTION 'Invalid cart'; END IF;
    FOR line IN SELECT value FROM jsonb_array_elements(p_answer->'lines') LOOP
      IF COALESCE(line->>'kind','') NOT IN ('bundle','product') OR COALESCE(line->>'quantity','') !~ '^[0-9]+$'
        OR (line->>'quantity')::numeric NOT BETWEEN 1 AND 1000
        OR COALESCE(line->>'id','') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
        THEN RAISE EXCEPTION 'Invalid cart line'; END IF;
    END LOOP;
    SELECT jsonb_build_object('version',1,'lines',COALESCE(jsonb_agg(v ORDER BY v->>'kind',v->>'id'),'[]')) INTO normalized
      FROM (SELECT jsonb_build_object('kind',value->>'kind','id',lower(value->>'id'),'quantity',sum((value->>'quantity')::integer)) v
        FROM jsonb_array_elements(p_answer->'lines') GROUP BY value->>'kind',lower(value->>'id')) n;
    IF h.answer IS DISTINCT FROM normalized AND h.version IS DISTINCT FROM p_expected_version THEN
      RAISE EXCEPTION 'Cart changed in another tab. Reload the reservation.' USING ERRCODE='40001';
    END IF;
    FOR line IN SELECT value FROM jsonb_array_elements(normalized->'lines') LOOP
      IF (line->>'quantity')::integer>1000 OR NOT COALESCE(field->CASE WHEN line->>'kind'='bundle'
        THEN 'allowed_bundle_ids' ELSE 'allowed_product_ids' END ? (line->>'id'),false) THEN RAISE EXCEPTION 'Cart item not allowed'; END IF;
      IF line->>'kind'='bundle' THEN
        maximum:=COALESCE((field->'bundle_max_quantities'->>(line->>'id'))::integer,1000);
        IF (line->>'quantity')::integer>maximum THEN RAISE EXCEPTION 'Bundle purchase limit exceeded'; END IF;
        SELECT to_jsonb(b) INTO item FROM public.sales_catalogue_bundle b WHERE tenant_id=p_tenant_id AND id=(line->>'id')::uuid;
      ELSE
        SELECT to_jsonb(p) INTO item FROM public.sales_catalogue_product p WHERE tenant_id=p_tenant_id AND id=(line->>'id')::uuid;
      END IF;
      IF item IS NULL OR item->>'is_active' IS DISTINCT FROM 'true' OR item->>'archived_at' IS NOT NULL
        OR (item->>'available_from')::timestamptz>now() OR (item->>'available_to')::timestamptz<now()
        THEN RAISE EXCEPTION 'Cart item unavailable'; END IF;
    END LOOP;
    PERFORM public.replace_form_cart_hold_stock(p_tenant_id,h.answer,normalized);
    UPDATE public.form_cart_hold SET answer=normalized,version=version+1,
      state=CASE WHEN jsonb_array_length(normalized->'lines')=0 THEN 'released' ELSE 'shopping' END
      WHERE id=p_id RETURNING * INTO h;
  END IF;
  IF h.state='checkout' THEN
    SELECT state INTO receipt_state FROM public.form_cart_receipt WHERE submission_id=h.submission_id;
  END IF;
  RETURN jsonb_build_object('id',h.id,'answer',h.answer,'version',h.version,
    'expiresAt',h.expires_at,'serverNow',now(),'state',COALESCE(receipt_state,h.state));
END;
$$;

-- Preserve the reviewed pricing, invoice, and stock guards in the existing
-- implementation. Release-and-reacquire happens inside one transaction with
-- locks held throughout: no second customer can take this stock in between.
ALTER FUNCTION public.reserve_form_cart(uuid,uuid) RENAME TO reserve_form_cart_without_shopping_hold;
CREATE FUNCTION public.reserve_form_cart(p_tenant_id uuid,p_submission_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE s public.form_submission; h public.form_cart_hold; terms jsonb; token text; expected jsonb;
BEGIN
  SELECT * INTO s FROM public.form_submission WHERE tenant_id=p_tenant_id AND id=p_submission_id FOR UPDATE;
  SELECT r.terms INTO terms FROM public.form_cart_receipt r WHERE r.tenant_id=p_tenant_id AND r.submission_id=p_submission_id;
  IF FOUND THEN RETURN terms; END IF;
  token:=s.submission_data->>'__cart_reservation';
  IF token IS NULL THEN RETURN public.reserve_form_cart_without_shopping_hold(p_tenant_id,p_submission_id); END IF;
  SELECT * INTO h FROM public.form_cart_hold WHERE id=token::uuid AND tenant_id=p_tenant_id AND form_id=s.form_id FOR UPDATE;
  IF NOT FOUND OR h.state<>'shopping' OR h.expires_at<=now() THEN RAISE EXCEPTION 'Cart reservation expired'; END IF;
  SELECT s.submission_data->(value->>'id') INTO expected FROM public.form f,
    LATERAL jsonb_array_elements(f.fields) WHERE f.id=s.form_id AND f.tenant_id=p_tenant_id AND value->>'type'='sales_cart';
  IF (expected-'reservation_id') IS DISTINCT FROM h.answer THEN RAISE EXCEPTION 'Cart does not match its reservation'; END IF;
  PERFORM public.replace_form_cart_hold_stock(p_tenant_id,h.answer,'{"version":1,"lines":[]}');
  terms:=public.reserve_form_cart_without_shopping_hold(p_tenant_id,p_submission_id);
  IF terms IS NULL THEN RAISE EXCEPTION 'Reserved cart cannot be hidden at checkout'; END IF;
  UPDATE public.form_cart_hold SET state='checkout',submission_id=p_submission_id,version=version+1 WHERE id=h.id;
  UPDATE public.form_cart_receipt SET next_check_at=h.expires_at WHERE submission_id=p_submission_id AND state='held';
  RETURN terms;
END;
$$;
REVOKE ALL ON FUNCTION public.reserve_form_cart_without_shopping_hold(uuid,uuid),
  public.replace_form_cart_hold_stock(uuid,jsonb,jsonb) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.update_form_cart_hold(uuid,uuid,uuid,jsonb,bigint),
  public.reserve_form_cart(uuid,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.update_form_cart_hold(uuid,uuid,uuid,jsonb,bigint),
  public.reserve_form_cart(uuid,uuid) TO service_role;

CREATE FUNCTION public.expire_form_cart_shopping_holds(p_limit integer DEFAULT 100)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE h public.form_cart_hold; changed integer:=0;
BEGIN
  FOR h IN SELECT * FROM public.form_cart_hold WHERE state='shopping' AND expires_at<=now()
    ORDER BY expires_at,id LIMIT LEAST(GREATEST(p_limit,1),100) FOR UPDATE SKIP LOCKED LOOP
    PERFORM public.replace_form_cart_hold_stock(h.tenant_id,h.answer,'{"version":1,"lines":[]}');
    UPDATE public.form_cart_hold SET state='released',version=version+1 WHERE id=h.id;
    changed:=changed+1;
  END LOOP;
  RETURN changed;
END;
$$;
REVOKE ALL ON FUNCTION public.expire_form_cart_shopping_holds(integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.expire_form_cart_shopping_holds(integer) TO service_role;

-- Back from checkout keeps the existing cart editable for the remainder of
-- its ORIGINAL deadline. It never extends the hold or revives an expired one.
CREATE FUNCTION public.resume_form_cart_shopping(p_tenant_id uuid,p_submission_id uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE h public.form_cart_hold;
BEGIN
  PERFORM 1 FROM public.form_submission WHERE tenant_id=p_tenant_id AND id=p_submission_id FOR UPDATE;
  SELECT * INTO h FROM public.form_cart_hold WHERE tenant_id=p_tenant_id AND submission_id=p_submission_id FOR UPDATE;
  IF NOT FOUND OR h.state<>'checkout' OR h.expires_at<=now() THEN RETURN false; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.form_cart_receipt WHERE tenant_id=p_tenant_id
    AND submission_id=p_submission_id AND state='released') THEN
    RAISE EXCEPTION 'Verified cancellation required before returning to cart';
  END IF;
  PERFORM public.replace_form_cart_hold_stock(p_tenant_id,'{"version":1,"lines":[]}',h.answer);
  UPDATE public.form_cart_hold SET state='shopping',submission_id=NULL,version=version+1 WHERE id=h.id;
  RETURN true;
END;
$$;
REVOKE ALL ON FUNCTION public.resume_form_cart_shopping(uuid,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.resume_form_cart_shopping(uuid,uuid) TO service_role;

-- Fixed-deadline holds must never be extended by the old activity heartbeat.
CREATE OR REPLACE FUNCTION public.touch_form_cart_activity(p_tenant_id uuid,p_submission_id uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE s public.form_submission; changed uuid; expiry timestamptz;
BEGIN
  SELECT * INTO s FROM public.form_submission WHERE tenant_id=p_tenant_id AND id=p_submission_id FOR UPDATE;
  IF NOT FOUND OR s.payment_provider IS DISTINCT FROM 'stripe' OR s.payment_status='paid' THEN RETURN false; END IF;
  SELECT expires_at INTO expiry FROM public.form_cart_hold WHERE tenant_id=p_tenant_id AND submission_id=p_submission_id;
  IF FOUND THEN RETURN expiry>now() AND EXISTS(SELECT 1 FROM public.form_cart_receipt
    WHERE tenant_id=p_tenant_id AND submission_id=p_submission_id AND state='held' AND cleanup_started_at IS NULL); END IF;
  UPDATE public.form_cart_receipt SET next_check_at=now()+interval '5 minutes'
    WHERE tenant_id=p_tenant_id AND submission_id=p_submission_id AND state='held'
      AND cleanup_started_at IS NULL AND next_check_at>now() RETURNING id INTO changed;
  RETURN changed IS NOT NULL;
END;
$$;
CREATE FUNCTION public.form_cart_shopping_hold_version() RETURNS integer LANGUAGE sql STABLE
SET search_path=public,pg_temp AS $$ SELECT 1; $$;
REVOKE ALL ON FUNCTION public.form_cart_shopping_hold_version() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.form_cart_shopping_hold_version() TO service_role;
COMMIT;
