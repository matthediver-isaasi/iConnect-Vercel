-- Variable credit is a reservation, not a fixed future membership liability.
-- Service-only period and collection evidence. No existing rows are backfilled.
CREATE TABLE public.membership_variable_voucher_period (
 settlement_id uuid PRIMARY KEY REFERENCES public.membership_voucher_settlement(id),
 tenant_id uuid NOT NULL,
 term_key text NOT NULL,
 instalment_count integer NOT NULL CHECK(instalment_count BETWEEN 1 AND 120),
 credit_minor bigint NOT NULL CHECK(credit_minor>0),
 UNIQUE(tenant_id,settlement_id)
);
CREATE TABLE public.membership_variable_voucher_slice (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL,
 settlement_id uuid NOT NULL REFERENCES public.membership_variable_voucher_period(settlement_id),
 ordinal integer NOT NULL CHECK(ordinal>0),
 purchase_key text NOT NULL UNIQUE,
 allocated_minor bigint NOT NULL CHECK(allocated_minor>=0),
 reservation_id uuid UNIQUE REFERENCES public.gocardless_collection_reservations(id) DEFERRABLE INITIALLY DEFERRED,
 state text NOT NULL DEFAULT 'reserved' CHECK(state IN ('reserved','bound','settled','released')),
 gross_minor bigint CHECK(gross_minor>0),
 credit_minor bigint CHECK(credit_minor>=0),
 cash_minor bigint CHECK(cash_minor>=0),
 allocations jsonb NOT NULL DEFAULT '[]',
 settled_at timestamptz,
 UNIQUE(settlement_id,ordinal),
 CHECK(gross_minor IS NULL OR gross_minor=credit_minor+cash_minor),
 CHECK(credit_minor IS NULL OR credit_minor<=allocated_minor)
);
ALTER TABLE public.membership_variable_voucher_period ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.membership_variable_voucher_slice ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.membership_variable_voucher_period,public.membership_variable_voucher_slice FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.membership_variable_voucher_period,public.membership_variable_voucher_slice TO service_role;
CREATE POLICY variable_voucher_period_service ON public.membership_variable_voucher_period TO service_role USING(true);
CREATE POLICY variable_voucher_slice_service ON public.membership_variable_voucher_slice TO service_role USING(true);

CREATE FUNCTION public.membership_variable_voucher_reserve(
 p_tenant_id uuid,p_token_id uuid,p_quote_id uuid,p_fingerprint text,p_history_snapshot jsonb,
 p_authenticated_member_id uuid DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE t public.membership_fee_token%ROWTYPE; q public.membership_voucher_quote%ROWTYPE;
 s public.membership_voucher_settlement%ROWTYPE; h public.member_membership_history%ROWTYPE;
 snap jsonb; total bigint; n integer; i integer; allocated bigint; funding jsonb;
 ids uuid[]; available_ids uuid[]; item jsonb; schedule jsonb:='[]'; all_allocations jsonb:='[]';
 cols text; vals text; history jsonb; key text;
BEGIN
 SELECT * INTO t FROM public.membership_fee_token WHERE id=p_token_id AND tenant_id=p_tenant_id FOR UPDATE;
 IF NOT FOUND OR t.member_id IS NULL OR t.organization_id IS NOT NULL THEN RAISE EXCEPTION 'Individual membership required'; END IF;
 SELECT * INTO s FROM public.membership_voucher_settlement WHERE fee_token_id=t.id AND state<>'released' FOR UPDATE;
 IF FOUND THEN
  IF s.quote_id<>p_quote_id OR NOT coalesce((s.funding->>'variableCredit')::boolean,false) THEN RAISE EXCEPTION 'Different credit commitment exists'; END IF;
  RETURN to_jsonb(s);
 END IF;
 IF t.status<>'pending' OR t.expires_at<=now() OR t.stripe_payment_intent_id IS NOT NULL
  OR to_jsonb(t)->>'stripe_payment_attempted_at' IS NOT NULL THEN RAISE EXCEPTION 'Membership checkout unavailable'; END IF;
 SELECT * INTO q FROM public.membership_voucher_quote WHERE id=p_quote_id AND tenant_id=p_tenant_id
  AND fee_token_id=t.id AND member_id=t.member_id AND organization_id IS NULL;
 IF NOT FOUND OR q.expires_at<=now() OR q.fingerprint IS DISTINCT FROM p_fingerprint
  OR (q.quote->>'tokenUpdatedAt')::timestamptz IS DISTINCT FROM t.updated_at
  OR q.quote->>'variableCredit' IS DISTINCT FROM 'true'
  OR q.quote->>'currency' IS DISTINCT FROM upper(coalesce(t.currency,'GBP'))
  OR (q.authenticated_member_id IS NOT NULL AND q.authenticated_member_id IS DISTINCT FROM p_authenticated_member_id)
 THEN RAISE EXCEPTION 'Variable credit quote changed or authority expired'; END IF;
 snap:=q.quote->'monthlySnapshot'; n:=(snap->>'instalment_count')::integer;
 total:=(q.quote->>'creditMinor')::bigint;
 IF n IS NULL OR n NOT BETWEEN 1 AND 120 OR total IS NULL OR total<=0
  OR snap->>'payment_mode' IS DISTINCT FROM 'direct_debit'
  OR snap#>>'{collection_policy,version}' IS DISTINCT FROM '1'
  OR snap#>>'{collection_policy,pricing_policy}' IS DISTINCT FROM 'dynamic'
  OR snap->>'invoicing_mode' IS DISTINCT FROM 'per_instalment'
  OR nullif(snap#>>'{commitment,term_key}','') IS NULL
  OR snap->>'currency' IS DISTINCT FROM q.quote->>'currency'
  OR snap->>'membership_year' IS DISTINCT FROM t.membership_year
  OR q.quote->>'grossMinor' IS NOT NULL OR q.quote->>'cashMinor' IS NOT NULL
  OR snap->>'plan_total' IS NOT NULL
 THEN RAISE EXCEPTION 'Invalid variable membership period'; END IF;
 IF p_history_snapshot->>'tenant_id' IS DISTINCT FROM t.tenant_id::text
  OR p_history_snapshot->>'member_id' IS DISTINCT FROM t.member_id::text
  OR p_history_snapshot->>'organization_id' IS NOT NULL
  OR p_history_snapshot->>'membership_year' IS DISTINCT FROM t.membership_year
 THEN RAISE EXCEPTION 'Membership history owner mismatch'; END IF;
 PERFORM public.membership_fee_checkout_guard(p_tenant_id,p_token_id,'voucher');
 SELECT array_agg((a->>'voucherId')::uuid ORDER BY ord) INTO ids
  FROM jsonb_array_elements(q.quote->'allocations') WITH ORDINALITY AS a(a,ord);
 IF coalesce(cardinality(ids),0)=0 OR cardinality(ids)<> (SELECT count(DISTINCT v) FROM unnest(ids) v)
  OR (SELECT sum((a->>'amountMinor')::bigint) FROM jsonb_array_elements(q.quote->'allocations') a) IS DISTINCT FROM total
 THEN RAISE EXCEPTION 'Invalid source credit allocations'; END IF;
 -- Deterministic lock order across ALL monthly slices, not just one slice.
 PERFORM 1 FROM public.voucher WHERE tenant_id=p_tenant_id AND id=ANY(ids) ORDER BY id FOR UPDATE;
 IF t.history_record_id IS NOT NULL THEN
  SELECT * INTO h FROM public.member_membership_history
   WHERE id=t.history_record_id AND tenant_id=p_tenant_id AND member_id=t.member_id FOR UPDATE;
  IF NOT FOUND OR h.payment_status IN ('paid','voided','unverified') THEN RAISE EXCEPTION 'Original membership needs reconciliation'; END IF;
 ELSE
  history:=p_history_snapshot-'id'-'__accounting'-'paid_at'-'stripe_payment_intent_id'
   ||jsonb_build_object('status','pending_payment_setup','payment_status','unpaid',
      'final_cost',NULL,'total_with_vat',NULL,'vat_amount',NULL,'billing_period','monthly_direct_debit');
  SELECT string_agg(format('%I',entry.key),','),string_agg(format('(jsonb_populate_record(NULL::public.member_membership_history,$1)).%I',entry.key),',')
   INTO cols,vals FROM jsonb_each(history) entry;
  EXECUTE format('INSERT INTO public.member_membership_history(%s) SELECT %s RETURNING *',cols,vals) INTO h USING history;
 END IF;
 INSERT INTO public.membership_voucher_settlement(tenant_id,fee_token_id,quote_id,purchase_key,funding,history_snapshot,history_record_id,monthly_snapshot)
  VALUES(p_tenant_id,t.id,q.id,'variable-membership:'||t.id::text||':'||q.id::text,'{}',p_history_snapshot,h.id,snap) RETURNING * INTO s;
 INSERT INTO public.membership_variable_voucher_period VALUES(s.id,p_tenant_id,snap#>>'{commitment,term_key}',n,total);
 FOR i IN 1..n LOOP
  allocated:=total/n+CASE WHEN i<=total%n THEN 1 ELSE 0 END;
  key:=s.purchase_key||':'||i::text;
  -- The shared reservation service rechecks expiry, tenant, ownership and
  -- authenticated organisation authority under the same voucher locks.
  SELECT coalesce(array_agg(id ORDER BY expires_at,issued_at,id),'{}'::uuid[]) INTO available_ids
   FROM public.voucher WHERE tenant_id=p_tenant_id AND id=ANY(ids) AND value>0;
  funding:=public.voucher_credit_reserve(p_tenant_id,key,t.member_id,p_authenticated_member_id,
   available_ids,allocated,snap->>'currency',q.authenticated_member_id IS NOT NULL,false);
  IF (funding->>'voucherMinor')::bigint IS DISTINCT FROM allocated THEN RAISE EXCEPTION 'Credit balance changed'; END IF;
  INSERT INTO public.membership_variable_voucher_slice(tenant_id,settlement_id,ordinal,purchase_key,allocated_minor,allocations)
   VALUES(p_tenant_id,s.id,i,key,allocated,funding->'allocations');
  schedule:=schedule||jsonb_build_array(jsonb_build_object('ordinal',i,'allocatedCreditMinor',allocated));
  all_allocations:=all_allocations||(funding->'allocations');
 END LOOP;
 IF schedule IS DISTINCT FROM q.quote->'creditSchedule' THEN RAISE EXCEPTION 'Credit schedule changed'; END IF;
 -- Preserve original source identity; no projected gross or cash liabilities.
 UPDATE public.membership_voucher_settlement SET funding=jsonb_build_object(
  'variableCredit',true,'payableMinor',NULL,'remainingMinor',NULL,'voucherMinor',total,
  'currency',snap->>'currency','allocations',all_allocations,'creditSchedule',schedule)
  WHERE id=s.id RETURNING * INTO s;
 UPDATE public.membership_fee_token SET history_record_id=h.id,updated_at=now() WHERE id=t.id;
 RETURN to_jsonb(s);
END $$;

CREATE FUNCTION public.membership_variable_voucher_commit(p_tenant_id uuid,p_settlement_id uuid,p_agreement_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE s public.membership_voucher_settlement%ROWTYPE; a public.membership_billing_agreements%ROWTYPE;
BEGIN
 SELECT * INTO a FROM public.membership_billing_agreements WHERE id=p_agreement_id AND tenant_id=p_tenant_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Agreement unavailable'; END IF;
 SELECT * INTO s FROM public.membership_voucher_settlement WHERE id=p_settlement_id AND tenant_id=p_tenant_id FOR UPDATE;
 IF NOT FOUND OR s.state='released' OR s.funding->>'variableCredit' IS DISTINCT FROM 'true'
  OR a.member_id::text IS DISTINCT FROM s.history_snapshot->>'member_id' OR a.organization_id IS NOT NULL
  OR a.metadata#>>'{dd,voucher_funding,settlement_id}' IS DISTINCT FROM s.id::text
  OR a.metadata#>>'{dd,voucher_funding,variable_credit}' IS DISTINCT FROM 'true'
  OR a.metadata#>>'{dd,commitment,term_key}' IS DISTINCT FROM s.monthly_snapshot#>>'{commitment,term_key}'
  OR a.metadata#>>'{dd,collection_policy,pricing_policy}' IS DISTINCT FROM 'dynamic'
  OR a.metadata#>>'{dd,invoicing_mode}' IS DISTINCT FROM 'per_instalment'
  OR a.metadata#>>'{dd,currency}' IS DISTINCT FROM s.funding->>'currency'
  OR a.metadata#>>'{dd,instalment_count}' IS DISTINCT FROM s.monthly_snapshot->>'instalment_count'
  OR a.metadata#>>'{dd,membership_year}' IS DISTINCT FROM s.monthly_snapshot->>'membership_year'
  OR (s.billing_agreement_id IS NOT NULL AND s.billing_agreement_id<>a.id)
 THEN RAISE EXCEPTION 'Agreement does not match variable credit reservation'; END IF;
 UPDATE public.membership_voucher_settlement SET billing_agreement_id=a.id,
  state=CASE WHEN state='committed' THEN state ELSE 'plan_committed' END,updated_at=now()
  WHERE id=s.id RETURNING * INTO s;
 UPDATE public.member_membership_history SET billing_agreement_id=a.id,payment_method='direct_debit',
  billing_period='monthly_direct_debit' WHERE id=s.history_record_id AND tenant_id=p_tenant_id;
 -- Nothing is consumed merely because consent or a mandate exists.
 RETURN to_jsonb(s);
END $$;

CREATE FUNCTION public.membership_variable_voucher_bind() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE a public.membership_billing_agreements%ROWTYPE; s public.membership_voucher_settlement%ROWTYPE;
 v public.membership_variable_voucher_slice%ROWTYPE; gross bigint; credit bigint; cash bigint;
BEGIN
 SELECT * INTO a FROM public.membership_billing_agreements WHERE id=NEW.billing_agreement_id AND tenant_id=NEW.tenant_id;
 IF a.metadata#>>'{dd,voucher_funding,variable_credit}' IS DISTINCT FROM 'true' THEN
  IF NEW.amount_minor<=0 THEN RAISE EXCEPTION 'Zero cash requires protected voucher settlement'; END IF;
  RETURN NEW;
 END IF;
 SELECT * INTO s FROM public.membership_voucher_settlement
  WHERE id=(a.metadata#>>'{dd,voucher_funding,settlement_id}')::uuid AND tenant_id=NEW.tenant_id FOR UPDATE;
 IF NOT FOUND OR s.state NOT IN ('plan_committed','committed') OR s.billing_agreement_id<>a.id
  OR s.monthly_snapshot#>>'{commitment,term_key}' IS DISTINCT FROM NEW.term_key
 THEN RAISE EXCEPTION 'Variable credit period is not committed to this agreement'; END IF;
 SELECT * INTO v FROM public.membership_variable_voucher_slice
  WHERE settlement_id=s.id AND ordinal=NEW.collection_number FOR UPDATE;
 IF NOT FOUND OR v.state<>'reserved' OR v.reservation_id IS NOT NULL THEN RAISE EXCEPTION 'Variable credit slice unavailable'; END IF;
 gross:=(NEW.price_snapshot->>'monthly_amount_minor')::bigint;
 IF gross IS NULL OR gross<=0 OR gross<>NEW.amount_minor THEN RAISE EXCEPTION 'Actual gross price is required'; END IF;
 credit:=least(gross,v.allocated_minor); cash:=gross-credit;
 IF cash>0 AND cash<100 THEN
  IF gross<100 THEN RAISE EXCEPTION 'Partially funded collection is below provider minimum'; END IF;
  cash:=100; credit:=gross-cash;
 END IF;
 UPDATE public.membership_variable_voucher_slice SET state='bound',reservation_id=NEW.id,
  gross_minor=gross,credit_minor=credit,cash_minor=cash WHERE id=v.id;
 NEW.amount_minor:=cash;
 RETURN NEW;
END $$;
CREATE TRIGGER membership_variable_voucher_bind BEFORE INSERT ON public.gocardless_collection_reservations
 FOR EACH ROW EXECUTE FUNCTION public.membership_variable_voucher_bind();
ALTER TABLE public.gocardless_collection_reservations DROP CONSTRAINT gocardless_collection_reservations_amount_minor_check;
ALTER TABLE public.gocardless_collection_reservations ADD CONSTRAINT gocardless_collection_reservations_amount_minor_check CHECK(amount_minor>=0);

-- Partial consumption retains the immutable original allocation and its
-- reservation ledger. The unused portion returns to that original voucher,
-- even if now expired, without granting a new expiry.
CREATE FUNCTION public.membership_variable_voucher_consume(p_tenant_id uuid,p_slice_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v public.membership_variable_voucher_slice%ROWTYPE; p public.voucher_credit_purchase%ROWTYPE;
 a public.voucher_credit_allocation%ROWTYPE; source public.voucher%ROWTYPE;
 remaining bigint; used bigint; unused bigint; result jsonb:='[]';
 previous_flag text:=current_setting('app.voucher_credit_write',true);
BEGIN
 SELECT * INTO v FROM public.membership_variable_voucher_slice WHERE id=p_slice_id AND tenant_id=p_tenant_id FOR UPDATE;
 IF NOT FOUND OR v.state<>'bound' THEN RAISE EXCEPTION 'Bound credit slice required'; END IF;
 SELECT * INTO p FROM public.voucher_credit_purchase WHERE tenant_id=p_tenant_id AND purchase_key=v.purchase_key FOR UPDATE;
 IF NOT FOUND OR p.state<>'reserved' THEN RAISE EXCEPTION 'Original voucher reservation unavailable'; END IF;
 PERFORM 1 FROM public.voucher WHERE id IN (SELECT voucher_id FROM public.voucher_credit_allocation WHERE purchase_id=p.id) ORDER BY id FOR UPDATE;
 remaining:=v.credit_minor;
 PERFORM set_config('app.voucher_credit_write','yes',true);
 FOR a IN SELECT * FROM public.voucher_credit_allocation WHERE purchase_id=p.id ORDER BY ordinal LOOP
  used:=least(remaining,a.amount_minor); unused:=a.amount_minor-used; remaining:=remaining-used;
  SELECT * INTO STRICT source FROM public.voucher WHERE id=a.voucher_id AND tenant_id=p_tenant_id;
  IF unused>0 THEN
   UPDATE public.voucher SET value=value+unused/100.0,
    status=CASE WHEN expires_at<=now() THEN 'expired' ELSE 'active' END WHERE id=source.id;
   INSERT INTO public.voucher_transaction(voucher_id,tenant_id,organization_id,owner_member_id,member_id,
    allocation_id,owner_display_name,amount,balance_before,balance_after,type,booking_reference)
    VALUES(source.id,p_tenant_id,a.organization_id,a.owner_member_id,p.member_id,a.id,a.owner_display_name,
     unused/100.0,source.value,source.value+unused/100.0,'reservation_release',v.purchase_key);
  END IF;
  IF used>0 THEN
   INSERT INTO public.voucher_transaction(voucher_id,tenant_id,organization_id,owner_member_id,member_id,
    allocation_id,owner_display_name,amount,balance_before,balance_after,type,booking_reference)
    VALUES(source.id,p_tenant_id,a.organization_id,a.owner_member_id,p.member_id,a.id,a.owner_display_name,
     used/100.0,source.value+unused/100.0,source.value+unused/100.0,'booking_usage',v.purchase_key);
   result:=result||jsonb_build_array(jsonb_build_object('id',a.id,'voucherId',a.voucher_id,'amountMinor',used,
    'ownerType',CASE WHEN a.owner_member_id IS NULL THEN 'organization' ELSE 'member' END,
    'memberId',a.owner_member_id,'organizationId',a.organization_id,'displayName',a.owner_display_name));
  END IF;
 END LOOP;
 IF remaining<>0 THEN RAISE EXCEPTION 'Reserved sources do not cover actual credit'; END IF;
 UPDATE public.voucher_credit_purchase SET state='committed',committed_at=now() WHERE id=p.id;
 PERFORM set_config('app.voucher_credit_write',coalesce(previous_flag,''),true);
 RETURN result;
END $$;
-- Internal consumption is callable only by the evidence-checking transaction,
-- not by service-role callers supplying an arbitrary credit amount.
REVOKE ALL ON FUNCTION public.membership_variable_voucher_consume(uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION public.membership_variable_voucher_settle_collection(p_tenant_id uuid,p_reservation_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE r public.gocardless_collection_reservations%ROWTYPE; p public.membership_payment_plans%ROWTYPE;
 a public.membership_billing_agreements%ROWTYPE; s public.membership_voucher_settlement%ROWTYPE;
 v public.membership_variable_voucher_slice%ROWTYPE; c public.membership_voucher_collection%ROWTYPE;
 consumed_allocations jsonb; next_due date;
BEGIN
 -- Match the normal collection lock order: plan, agreement, settlement, slice.
 SELECT * INTO r FROM public.gocardless_collection_reservations WHERE id=p_reservation_id AND tenant_id=p_tenant_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'Collection reservation unavailable'; END IF;
 SELECT * INTO p FROM public.membership_payment_plans WHERE id=r.plan_id AND tenant_id=p_tenant_id FOR UPDATE;
 SELECT * INTO a FROM public.membership_billing_agreements WHERE id=r.billing_agreement_id AND tenant_id=p_tenant_id FOR UPDATE;
 SELECT * INTO s FROM public.membership_voucher_settlement WHERE
  id=(a.metadata#>>'{dd,voucher_funding,settlement_id}')::uuid AND tenant_id=p_tenant_id FOR UPDATE;
 SELECT * INTO v FROM public.membership_variable_voucher_slice WHERE reservation_id=r.id AND tenant_id=p_tenant_id FOR UPDATE;
 IF NOT FOUND OR s.id IS DISTINCT FROM v.settlement_id OR s.billing_agreement_id IS DISTINCT FROM a.id
  OR r.term_key IS DISTINCT FROM s.monthly_snapshot#>>'{commitment,term_key}'
  OR r.amount_minor IS DISTINCT FROM v.cash_minor THEN RAISE EXCEPTION 'Collection funding identity mismatch'; END IF;
 IF v.state='settled' THEN
  SELECT * INTO STRICT c FROM public.membership_voucher_collection WHERE settlement_id=s.id AND ordinal=v.ordinal;
  RETURN to_jsonb(c);
 END IF;
 IF v.state<>'bound' THEN RAISE EXCEPTION 'Collection credit was released'; END IF;
 IF v.cash_minor>0 THEN
  PERFORM 1 FROM public.gocardless_payments g WHERE g.gocardless_payment_id=r.gocardless_payment_id
   AND g.tenant_id=p_tenant_id AND g.plan_id=p.id AND g.gocardless_mandate_id=p.gocardless_mandate_id
   AND g.amount_minor=r.amount_minor AND upper(g.currency)=upper(r.currency)
   AND g.charge_date=r.requested_charge_date AND g.status IN ('confirmed','paid_out') FOR UPDATE;
  IF NOT FOUND OR r.status<>'submitted' OR r.provider_evidence->>'status' NOT IN ('confirmed','paid_out')
   THEN RAISE EXCEPTION 'Confirmed provider evidence required before consuming credit'; END IF;
 ELSE
  IF r.gocardless_payment_id IS NOT NULL OR r.due_date>current_date OR p.collection_stopped_at IS NOT NULL
   OR p.status NOT IN ('active','mandate_pending','first_payment_pending')
   OR a.status NOT IN ('active','mandate_pending','first_payment_pending')
   OR a.metadata#>>'{dd,arrears_state}' IS NOT NULL
   OR EXISTS(SELECT 1 FROM public.membership_monthly_arrears_period WHERE tenant_id=p_tenant_id AND plan_id=p.id AND settled_at IS NULL)
   OR NOT EXISTS(SELECT 1 FROM public.member WHERE id=a.member_id AND tenant_id=p_tenant_id
     AND NOT coalesce(membership_paused,false) AND coalesce(status,'active') NOT IN ('cancelled','deleted','paused'))
  THEN RAISE EXCEPTION 'Internal collection is not due or is lifecycle-blocked'; END IF;
 END IF;
 consumed_allocations:=public.membership_variable_voucher_consume(p_tenant_id,v.id);
 UPDATE public.membership_variable_voucher_slice SET state='settled',settled_at=now(),allocations=consumed_allocations WHERE id=v.id;
 INSERT INTO public.membership_voucher_collection(tenant_id,settlement_id,ordinal,external_reference,provider,cash_minor,collection_date)
  VALUES(p_tenant_id,s.id,v.ordinal,CASE WHEN v.cash_minor=0 THEN 'variable-voucher:'||r.id::text
    ELSE r.gocardless_payment_id||':unit:1' END,CASE WHEN v.cash_minor=0 THEN 'voucher' ELSE 'gocardless' END,
    v.cash_minor,r.due_date) RETURNING * INTO c;
 UPDATE public.member_membership_history SET payment_status='partial'
  WHERE id=s.history_record_id AND tenant_id=p_tenant_id AND payment_status='unpaid';
 IF v.cash_minor=0 THEN
  UPDATE public.gocardless_collection_reservations SET status='submitted',updated_at=now() WHERE id=r.id;
  next_due:=public.gocardless_manual_collection_due_date(p_tenant_id,p.id,r.collection_number+1);
  IF r.collection_number >= (a.metadata#>>'{dd,instalment_count}')::integer
   OR next_due>(a.metadata#>>'{dd,commitment,term_end_date}')::date THEN next_due:=NULL; END IF;
  UPDATE public.membership_payment_plans SET dynamic_next_collection_date=next_due,
   dynamic_next_check_at=NULL,updated_at=now() WHERE id=p.id;
 END IF;
 RETURN to_jsonb(c);
END $$;

REVOKE ALL ON FUNCTION public.membership_variable_voucher_reserve(uuid,uuid,uuid,text,jsonb,uuid),
 public.membership_variable_voucher_commit(uuid,uuid,uuid),
 public.membership_variable_voucher_bind(),
 public.membership_variable_voucher_settle_collection(uuid,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.membership_variable_voucher_reserve(uuid,uuid,uuid,text,jsonb,uuid),
 public.membership_variable_voucher_commit(uuid,uuid,uuid),
 public.membership_variable_voucher_settle_collection(uuid,uuid) TO service_role;

CREATE FUNCTION public.membership_variable_voucher_release(p_tenant_id uuid,p_settlement_id uuid,
 p_agreement_id uuid,p_provider_reference text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE s public.membership_voucher_settlement%ROWTYPE; a public.membership_billing_agreements%ROWTYPE;
 v public.membership_variable_voucher_slice%ROWTYPE;
 prior text:=current_setting('app.variable_voucher_release',true);
BEGIN
 IF p_agreement_id IS NOT NULL THEN
  SELECT * INTO a FROM public.membership_billing_agreements WHERE id=p_agreement_id AND tenant_id=p_tenant_id FOR UPDATE;
  IF NOT FOUND OR a.gocardless_mandate_id IS NOT NULL OR p_provider_reference IS NULL
   OR p_provider_reference IS DISTINCT FROM a.gocardless_billing_request_id
   OR a.metadata#>>'{dd,voucher_funding,settlement_id}' IS DISTINCT FROM p_settlement_id::text
  THEN RAISE EXCEPTION 'Cancelled mandate setup evidence required'; END IF;
 END IF;
 SELECT * INTO s FROM public.membership_voucher_settlement WHERE id=p_settlement_id AND tenant_id=p_tenant_id FOR UPDATE;
 IF NOT FOUND OR s.funding->>'variableCredit' IS DISTINCT FROM 'true' THEN RAISE EXCEPTION 'Variable reservation unavailable'; END IF;
 IF s.state='released' THEN RETURN jsonb_build_object('released',true); END IF;
 IF s.state NOT IN ('reserved','provider_pending') OR (p_agreement_id IS NULL AND s.provider_attempted_at IS NOT NULL)
  OR EXISTS(SELECT 1 FROM public.membership_variable_voucher_slice WHERE settlement_id=s.id AND state<>'reserved')
 THEN RAISE EXCEPTION 'Committed or uncertain collection requires reconciliation'; END IF;
 PERFORM set_config('app.variable_voucher_release','yes',true);
 FOR v IN SELECT * FROM public.membership_variable_voucher_slice WHERE settlement_id=s.id ORDER BY ordinal FOR UPDATE LOOP
  PERFORM public.voucher_credit_transition(p_tenant_id,v.purchase_key,'release','not_started');
  UPDATE public.membership_variable_voucher_slice SET state='released' WHERE id=v.id;
 END LOOP;
 PERFORM set_config('app.variable_voucher_release',coalesce(prior,''),true);
 UPDATE public.membership_voucher_settlement SET state='released',updated_at=now() WHERE id=s.id;
 IF a.id IS NOT NULL THEN UPDATE public.membership_billing_agreements SET status='payment_plan_cancelled',updated_at=now() WHERE id=a.id; END IF;
 DELETE FROM public.membership_fee_checkout_claim WHERE fee_token_id=s.fee_token_id AND rail='voucher';
 DELETE FROM public.membership_payment_term_claim WHERE tenant_id=p_tenant_id AND source_key='fee:'||s.fee_token_id::text AND rail='voucher';
 RETURN jsonb_build_object('released',true);
END $$;
REVOKE ALL ON FUNCTION public.membership_variable_voucher_release(uuid,uuid,uuid,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.membership_variable_voucher_release(uuid,uuid,uuid,text) TO service_role;

-- Zero-cash reservations cannot acquire a provider ID via an older RPC or a
-- service-role table write. Internal evidence is held in the private slice.
CREATE FUNCTION public.membership_variable_voucher_provider_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
 IF NEW.amount_minor=0 AND (NEW.gocardless_payment_id IS NOT NULL OR NEW.provider_charge_date IS NOT NULL) THEN
  RAISE EXCEPTION 'Voucher-only collection cannot have a provider payment';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER membership_variable_voucher_provider_guard BEFORE INSERT OR UPDATE ON public.gocardless_collection_reservations
 FOR EACH ROW EXECUTE FUNCTION public.membership_variable_voucher_provider_guard();

CREATE FUNCTION public.membership_variable_voucher_plan_end() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE s public.membership_voucher_settlement%ROWTYPE; v public.membership_variable_voucher_slice%ROWTYPE;
 prior text:=current_setting('app.variable_voucher_release',true);
BEGIN
 IF NEW.status NOT IN ('payment_plan_cancelled','expired') THEN RETURN NEW; END IF;
 SELECT * INTO s FROM public.membership_voucher_settlement
  WHERE billing_agreement_id=NEW.billing_agreement_id AND tenant_id=NEW.tenant_id AND funding->>'variableCredit'='true' FOR UPDATE;
 IF NOT FOUND THEN RETURN NEW; END IF;
 PERFORM set_config('app.variable_voucher_release','yes',true);
 FOR v IN SELECT * FROM public.membership_variable_voucher_slice WHERE settlement_id=s.id ORDER BY ordinal FOR UPDATE LOOP
  -- An unconfirmed provider request remains reserved, even after cancellation.
  -- Failed/cancelled requests can only release once the plan is stopped and
  -- its canonical provider mirror agrees. Successful cash is never released.
  IF v.state='reserved' OR (NEW.status='payment_plan_cancelled' AND v.state='bound' AND EXISTS(
   SELECT 1 FROM public.gocardless_collection_reservations r
   LEFT JOIN public.gocardless_payments g ON g.gocardless_payment_id=r.gocardless_payment_id
   WHERE r.id=v.reservation_id AND r.tenant_id=NEW.tenant_id AND r.plan_id=NEW.id
    AND (r.amount_minor=0 AND r.gocardless_payment_id IS NULL OR
      g.tenant_id=NEW.tenant_id AND g.plan_id=NEW.id AND g.amount_minor=r.amount_minor
      AND g.status IN ('failed','cancelled') AND r.provider_evidence->>'status'=g.status))) THEN
   PERFORM public.voucher_credit_transition(NEW.tenant_id,v.purchase_key,'release','cancelled');
   UPDATE public.membership_variable_voucher_slice SET state='released' WHERE id=v.id;
  END IF;
 END LOOP;
 PERFORM set_config('app.variable_voucher_release',coalesce(prior,''),true);
 RETURN NEW;
END $$;
CREATE TRIGGER membership_variable_voucher_plan_end AFTER UPDATE OF status ON public.membership_payment_plans
 FOR EACH ROW EXECUTE FUNCTION public.membership_variable_voucher_plan_end();
REVOKE ALL ON FUNCTION public.membership_variable_voucher_bind(), public.membership_variable_voucher_provider_guard(),
 public.membership_variable_voucher_plan_end() FROM PUBLIC,anon,authenticated,service_role;

-- Surgical extensions of the installed contracts. Fail closed on unknown
-- definitions rather than installing an older function over newer safeguards.
DO $migration$
DECLARE definition text; old_text text; replacement text; fn regprocedure;
BEGIN
 fn:='public.voucher_credit_transition(uuid,text,text,text)'::regprocedure;
 SELECT pg_get_functiondef(fn) INTO definition;
 old_text:='t.type=''cancellation_refund''';
 IF (length(definition)-length(replace(definition,old_text,'')))/length(old_text)<>1 THEN
  RAISE EXCEPTION 'Unexpected voucher transition refund contract'; END IF;
 definition:=replace(definition,old_text,'t.type IN (''cancellation_refund'',''reservation_release'')');
 old_text:='BEGIN';
 replacement:=$body$BEGIN
 IF EXISTS(SELECT 1 FROM public.membership_variable_voucher_slice WHERE tenant_id=p_tenant_id AND purchase_key=p_purchase_key)
  AND (p_action='commit' OR current_setting('app.variable_voucher_release',true) IS DISTINCT FROM 'yes')
 THEN RAISE EXCEPTION 'Variable voucher slices require collection evidence'; END IF;
 $body$;
 definition:=replace(definition,old_text,replacement);
 EXECUTE definition;
 fn:='public.voucher_credit_refund_allocation(uuid,uuid,text,bigint,jsonb)'::regprocedure;
 SELECT pg_get_functiondef(fn) INTO definition;
 old_text:='t.type=''cancellation_refund''';
 IF (length(definition)-length(replace(definition,old_text,'')))/length(old_text)<>1 THEN
  RAISE EXCEPTION 'Unexpected voucher allocation refund contract'; END IF;
 EXECUTE replace(definition,old_text,'t.type IN (''cancellation_refund'',''reservation_release'')');
END $migration$;

CREATE FUNCTION public.membership_variable_voucher_complete_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM public.membership_variable_voucher_period WHERE settlement_id=NEW.id)
  AND NEW.state='committed' AND OLD.state IS DISTINCT FROM 'committed'
  AND NOT EXISTS(SELECT 1 FROM public.gocardless_dynamic_term_completions
    WHERE billing_agreement_id=NEW.billing_agreement_id AND tenant_id=NEW.tenant_id
      AND term_key=NEW.monthly_snapshot#>>'{commitment,term_key}')
 THEN RAISE EXCEPTION 'Variable membership completion requires term settlement evidence'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER membership_variable_voucher_complete_guard BEFORE UPDATE ON public.membership_voucher_settlement
 FOR EACH ROW EXECUTE FUNCTION public.membership_variable_voucher_complete_guard();

CREATE FUNCTION public.membership_variable_voucher_term_completed() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE s public.membership_voucher_settlement%ROWTYPE;
BEGIN
 SELECT * INTO s FROM public.membership_voucher_settlement WHERE billing_agreement_id=NEW.billing_agreement_id
  AND tenant_id=NEW.tenant_id AND funding->>'variableCredit'='true' FOR UPDATE;
 IF NOT FOUND THEN RETURN NEW; END IF;
 IF s.monthly_snapshot#>>'{commitment,term_key}' IS DISTINCT FROM NEW.term_key
  OR (SELECT count(*) FROM public.membership_variable_voucher_slice WHERE settlement_id=s.id AND state='settled')<>NEW.required_collections
 THEN RAISE EXCEPTION 'Variable period evidence is incomplete'; END IF;
 UPDATE public.membership_voucher_settlement SET state='committed',updated_at=now() WHERE id=s.id;
 UPDATE public.membership_fee_token SET status='paid',paid_at=coalesce(paid_at,now()),updated_at=now() WHERE id=s.fee_token_id;
 RETURN NEW;
END $$;
CREATE TRIGGER membership_variable_voucher_term_completed AFTER INSERT ON public.gocardless_dynamic_term_completions
 FOR EACH ROW EXECUTE FUNCTION public.membership_variable_voucher_term_completed();
REVOKE ALL ON FUNCTION public.membership_variable_voucher_complete_guard(),public.membership_variable_voucher_term_completed()
 FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION public.membership_variable_voucher_failed_after_cancel() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 IF NEW.status IN ('failed','cancelled') AND OLD.status IS DISTINCT FROM NEW.status THEN
  UPDATE public.membership_payment_plans SET status=status
   WHERE id=NEW.plan_id AND tenant_id=NEW.tenant_id AND status='payment_plan_cancelled';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER membership_variable_voucher_failed_after_cancel AFTER UPDATE OF status ON public.gocardless_payments
 FOR EACH ROW EXECUTE FUNCTION public.membership_variable_voucher_failed_after_cancel();
REVOKE ALL ON FUNCTION public.membership_variable_voucher_failed_after_cancel() FROM PUBLIC,anon,authenticated,service_role;

-- A fully funded, due collection has no provider debit date. Keep the actual
-- mandate observation intact, while using the intended date for internal
-- settlement. This is NOT a provider-payment evidence bypass.
CREATE FUNCTION public.membership_variable_voucher_internal_due(p_plan_id uuid,p_ordinal integer,p_due date,p_gross bigint)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT p_due<=current_date AND p_gross>0 AND EXISTS(
  SELECT 1 FROM public.membership_payment_plans p
  JOIN public.membership_voucher_settlement s ON s.billing_agreement_id=p.billing_agreement_id AND s.tenant_id=p.tenant_id
  JOIN public.membership_variable_voucher_slice v ON v.settlement_id=s.id AND v.ordinal=p_ordinal
  WHERE p.id=p_plan_id AND s.state='plan_committed' AND v.state='reserved'
   AND v.allocated_minor>=p_gross AND s.funding->>'variableCredit'='true')
$$;
REVOKE ALL ON FUNCTION public.membership_variable_voucher_internal_due(uuid,integer,date,bigint) FROM PUBLIC,anon,authenticated,service_role;
DO $migration$
DECLARE definition text; old_text text; predicate text;
BEGIN
 SELECT pg_get_functiondef('public.reserve_gocardless_dynamic_collection(uuid,uuid,integer,date,jsonb,jsonb,text)'::regprocedure) INTO definition;
 predicate:=$sql$public.membership_variable_voucher_internal_due(p.id,p_collection_number,p_due_date,(p_price_snapshot->>'monthly_amount_minor')::bigint)$sql$;
 FOREACH old_text IN ARRAY ARRAY[
  $sql$(p_provider_evidence->>'next_possible_charge_date')::date < p_due_date$sql$,
  $sql$(p_provider_evidence->>'next_possible_charge_date')::date > (terms->'commitment'->>'term_end_date')::date$sql$
 ] LOOP
  IF (length(definition)-length(replace(definition,old_text,'')))/length(old_text)<>1 THEN
   RAISE EXCEPTION 'Unexpected dynamic reservation notice contract'; END IF;
  definition:=replace(definition,old_text,'('||old_text||' AND NOT '||predicate||')');
 END LOOP;
 old_text:=$sql$p_collection_number,p_due_date,(p_provider_evidence->>'next_possible_charge_date')::date,$sql$;
 IF (length(definition)-length(replace(definition,old_text,'')))/length(old_text)<>1 THEN
  RAISE EXCEPTION 'Unexpected dynamic reservation charge date contract'; END IF;
 EXECUTE replace(definition,old_text,'p_collection_number,p_due_date,CASE WHEN '||predicate||
  $sql$ THEN p_due_date ELSE (p_provider_evidence->>'next_possible_charge_date')::date END,$sql$);
END $migration$;

DO $migration$
DECLARE definition text; old_text text; replacement text;
BEGIN
 SELECT pg_get_functiondef('public.complete_gocardless_dynamic_term(uuid,uuid)'::regprocedure) INTO definition;
 old_text:=$old$JOIN public.gocardless_payments g ON g.gocardless_payment_id=r.gocardless_payment_id$old$;
 IF (length(definition)-length(replace(definition,old_text,'')))/length(old_text)<>1 THEN
  RAISE EXCEPTION 'Unexpected dynamic completion payment join'; END IF;
 definition:=replace(definition,old_text,'LEFT '||old_text);
 old_text:=$old$AND r.provider_charge_date=r.requested_charge_date
      AND r.status='submitted' AND g.status IN ('confirmed','paid_out')
      AND r.provider_evidence->>'status' IN ('confirmed','paid_out')$old$;
 replacement:=$new$AND r.status='submitted'
      AND ((r.amount_minor>0 AND r.provider_charge_date=r.requested_charge_date
        AND g.status IN ('confirmed','paid_out') AND r.provider_evidence->>'status' IN ('confirmed','paid_out'))
       OR (r.amount_minor=0 AND r.gocardless_payment_id IS NULL AND EXISTS(
         SELECT 1 FROM public.membership_variable_voucher_slice vs
         JOIN public.membership_voucher_settlement ms ON ms.id=vs.settlement_id
         WHERE vs.reservation_id=r.id AND vs.tenant_id=p_tenant_id AND vs.state='settled'
          AND vs.cash_minor=0 AND vs.gross_minor=vs.credit_minor AND vs.settled_at IS NOT NULL
          AND ms.billing_agreement_id=a.id AND ms.monthly_snapshot#>>'{commitment,term_key}'=r.term_key)))
      AND (terms#>>'{voucher_funding,variable_credit}' IS DISTINCT FROM 'true' OR EXISTS(
        SELECT 1 FROM public.membership_variable_voucher_slice vs
        WHERE vs.reservation_id=r.id AND vs.tenant_id=p_tenant_id AND vs.state='settled'
          AND vs.cash_minor=r.amount_minor))$new$;
 IF (length(definition)-length(replace(definition,old_text,'')))/length(old_text)<>1 THEN
  RAISE EXCEPTION 'Unexpected dynamic completion payment evidence predicate'; END IF;
 definition:=replace(definition,old_text,replacement);
 old_text:=$old$'amount_minor',r.amount_minor,'currency',r.currency,'status',g.status$old$;
 replacement:=$new$'amount_minor',r.amount_minor,'currency',r.currency,'status',g.status,
    'internal_settlement',(SELECT jsonb_build_object('slice_id',vs.id,'settled_at',vs.settled_at,
      'gross_minor',vs.gross_minor,'credit_minor',vs.credit_minor,'cash_minor',vs.cash_minor)
      FROM public.membership_variable_voucher_slice vs WHERE vs.reservation_id=r.id AND vs.state='settled')$new$;
 IF (length(definition)-length(replace(definition,old_text,'')))/length(old_text)<>1 THEN
  RAISE EXCEPTION 'Unexpected dynamic completion evidence representation'; END IF;
 EXECUTE replace(definition,old_text,replacement);
END $migration$;
