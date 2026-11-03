-- Staged: this does not enable form voucher checkout.
BEGIN;
CREATE TABLE public.membership_post_grace_funding_evidence (
 reservation_id uuid PRIMARY KEY REFERENCES public.membership_post_grace_renewal(id),
 tenant_id uuid NOT NULL REFERENCES public.tenant(id),
 member_id uuid NOT NULL REFERENCES public.member(id),
 settlement_id uuid NOT NULL REFERENCES public.membership_voucher_settlement(id),
 provider text NOT NULL CHECK(provider IN ('stripe','gocardless','credit')),
 payment_id text NOT NULL,
 paid_at timestamptz NOT NULL,
 gross_minor bigint NOT NULL CHECK(gross_minor>0),
 cash_minor bigint NOT NULL CHECK(cash_minor>=0),
 credit_minor bigint NOT NULL CHECK(credit_minor>=0),
 currency text NOT NULL,
 full_term_credit boolean NOT NULL DEFAULT false,
 CHECK(gross_minor=cash_minor+credit_minor)
);
ALTER TABLE public.membership_post_grace_funding_evidence ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.membership_post_grace_funding_evidence FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.membership_post_grace_funding_evidence TO service_role;

CREATE FUNCTION public.apply_post_grace_funded_dates(
 p_tenant_id uuid,p_member_id uuid,p_reservation_id uuid,p_settlement_id uuid,
 p_provider text,p_payment_id text,p_status text,p_paid_at timestamptz,
 p_cash_minor bigint,p_currency text,p_expected jsonb
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE r public.membership_post_grace_renewal%ROWTYPE;
 s public.membership_voucher_settlement%ROWTYPE;
 proof public.membership_post_grace_funding_evidence%ROWTYPE;
 v public.membership_variable_voucher_slice%ROWTYPE;
 collection public.gocardless_collection_reservations%ROWTYPE;
 gross bigint; credit bigint; cash bigint; n integer; full_credit boolean:=false;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('rolling:'||p_tenant_id::text||':member_id:'||p_member_id::text,0));
 SELECT * INTO r FROM public.membership_post_grace_renewal
  WHERE id=p_reservation_id AND tenant_id=p_tenant_id AND member_id=p_member_id FOR UPDATE;
 IF NOT FOUND OR r.status='released' THEN RAISE EXCEPTION 'Restart reservation unavailable'; END IF;
 SELECT * INTO s FROM public.membership_voucher_settlement
  WHERE id=p_settlement_id AND tenant_id=p_tenant_id FOR UPDATE;
 IF NOT FOUND OR s.state='released' OR NOT EXISTS(
  SELECT FROM public.form_membership_voucher_checkout b
  JOIN public.membership_fee_token t ON t.id=b.fee_token_id
  WHERE b.election_id=r.election_id AND b.fee_token_id=s.fee_token_id
   AND b.tenant_id=p_tenant_id AND b.member_id=p_member_id AND b.released_at IS NULL
   AND t.tenant_id=p_tenant_id AND t.member_id=p_member_id AND t.organization_id IS NULL
   AND t.status IN ('pending','expired','paid')
 ) OR s.history_record_id IS DISTINCT FROM (p_expected#>>'{history,id}')::uuid
 THEN RAISE EXCEPTION 'Credit does not belong to this restart'; END IF;
 IF p_currency IS DISTINCT FROM s.funding->>'currency' OR p_currency IS DISTINCT FROM r.currency THEN
  RAISE EXCEPTION 'Restart funding currency mismatch';
 END IF;
 IF s.funding->>'variableCredit'='true' THEN
  SELECT * INTO v FROM public.membership_variable_voucher_slice
   WHERE settlement_id=s.id AND tenant_id=p_tenant_id AND ordinal=1 FOR UPDATE;
  IF NOT FOUND OR v.state NOT IN ('bound','settled') OR v.reservation_id IS NULL THEN
   RAISE EXCEPTION 'First variable collection evidence is unavailable';
  END IF;
  SELECT * INTO collection FROM public.gocardless_collection_reservations
   WHERE id=v.reservation_id AND tenant_id=p_tenant_id FOR UPDATE;
  IF NOT FOUND OR collection.amount_minor IS DISTINCT FROM v.cash_minor
   OR collection.plan_id IS DISTINCT FROM (p_expected#>>'{plan,id}')::uuid
   OR s.billing_agreement_id IS DISTINCT FROM (p_expected#>>'{agreement,id}')::uuid
  THEN RAISE EXCEPTION 'Variable collection ownership mismatch'; END IF;
  gross:=v.gross_minor; credit:=v.credit_minor; cash:=v.cash_minor;
  IF cash=0 THEN
   IF v.state<>'settled' OR p_provider<>'credit'
    OR p_payment_id IS DISTINCT FROM 'variable-voucher:'||collection.id::text
    OR p_paid_at IS DISTINCT FROM v.settled_at THEN
    RAISE EXCEPTION 'Settled internal credit evidence is required';
   END IF;
  ELSIF p_provider<>'gocardless' OR p_payment_id IS DISTINCT FROM collection.gocardless_payment_id THEN
   RAISE EXCEPTION 'Variable payment identity mismatch';
  END IF;
 ELSIF s.monthly_snapshot IS NOT NULL THEN
  n:=(s.monthly_snapshot->>'instalment_count')::integer;
  IF n IS NULL OR n<1 OR n>120 OR (s.funding->>'remainingMinor')::bigint % n <> 0 THEN
   RAISE EXCEPTION 'Invalid fixed monthly funding';
  END IF;
  gross:=(s.funding->>'payableMinor')::bigint/n
   +CASE WHEN (s.funding->>'payableMinor')::bigint % n>0 THEN 1 ELSE 0 END;
  credit:=(s.funding->>'voucherMinor')::bigint/n
   +CASE WHEN (s.funding->>'voucherMinor')::bigint % n>0 THEN 1 ELSE 0 END;
  cash:=(s.funding->>'remainingMinor')::bigint/n;
  full_credit:=(s.funding->>'remainingMinor')::bigint=0;
  IF NOT full_credit AND s.billing_agreement_id IS DISTINCT FROM (p_expected#>>'{agreement,id}')::uuid THEN
   RAISE EXCEPTION 'Fixed payment arrangement mismatch';
  END IF;
 ELSE
  gross:=(s.funding->>'payableMinor')::bigint;
  credit:=(s.funding->>'voucherMinor')::bigint;
  cash:=(s.funding->>'remainingMinor')::bigint;
  full_credit:=cash=0;
  IF r.payment_method<>'upfront' THEN RAISE EXCEPTION 'Monthly funding snapshot is required'; END IF;
  IF cash>0 AND (p_provider<>'stripe' OR p_payment_id IS DISTINCT FROM s.provider_payment_id) THEN
   RAISE EXCEPTION 'Upfront cash payment identity mismatch';
  END IF;
 END IF;
 IF gross IS NULL OR credit IS NULL OR cash IS NULL OR gross<=0 OR credit<0 OR cash<0
  OR gross<>credit+cash OR cash IS DISTINCT FROM p_cash_minor
  OR (cash=0 AND p_provider<>'credit') OR (cash>0 AND p_provider='credit')
 THEN RAISE EXCEPTION 'Cash and credit do not reconcile with the reserved first payment'; END IF;
 IF full_credit AND (p_provider<>'credit' OR p_payment_id IS DISTINCT FROM 'voucher:'||s.id::text) THEN
  RAISE EXCEPTION 'Fully funded membership identity mismatch';
 END IF;
 IF full_credit AND (s.billing_agreement_id IS NOT NULL OR EXISTS(
  SELECT FROM public.membership_billing_agreements a WHERE a.tenant_id=p_tenant_id
   AND a.member_id=p_member_id AND a.membership_successor_election_id=r.election_id
   AND a.status NOT IN ('cancelled','completed','expired')
 )) THEN RAISE EXCEPTION 'An existing payment arrangement must be reconciled before full-credit settlement'; END IF;
 SELECT * INTO proof FROM public.membership_post_grace_funding_evidence WHERE reservation_id=r.id FOR UPDATE;
 IF FOUND THEN
  IF proof.settlement_id IS DISTINCT FROM s.id OR proof.provider IS DISTINCT FROM p_provider
   OR proof.payment_id IS DISTINCT FROM p_payment_id OR proof.paid_at IS DISTINCT FROM p_paid_at
   OR proof.cash_minor IS DISTINCT FROM cash OR proof.credit_minor IS DISTINCT FROM credit
   OR proof.gross_minor IS DISTINCT FROM gross OR proof.currency IS DISTINCT FROM p_currency
   OR proof.full_term_credit IS DISTINCT FROM full_credit THEN
   RAISE EXCEPTION 'Different restart funding has already been applied';
  END IF;
 ELSE
  INSERT INTO public.membership_post_grace_funding_evidence
   (reservation_id,tenant_id,member_id,settlement_id,provider,payment_id,paid_at,gross_minor,cash_minor,credit_minor,currency,full_term_credit)
  VALUES(r.id,p_tenant_id,p_member_id,s.id,p_provider,p_payment_id,p_paid_at,gross,cash,credit,p_currency,full_credit);
 END IF;
 -- The underlying journal receives total funded value. The separate immutable
 -- proof above records the actual provider cash; it is never labelled as cash.
 RETURN public.apply_post_grace_record_dates(p_tenant_id,p_member_id,r.id,p_provider,
  p_payment_id,p_status,p_paid_at,gross,p_currency,p_expected);
END $$;
REVOKE ALL ON FUNCTION public.apply_post_grace_funded_dates(uuid,uuid,uuid,uuid,text,text,text,timestamptz,bigint,text,jsonb)
 FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.apply_post_grace_funded_dates(uuid,uuid,uuid,uuid,text,text,text,timestamptz,bigint,text,jsonb)
 TO service_role;

CREATE FUNCTION public.complete_post_grace_membership_voucher(
 p_tenant_id uuid,p_token_id uuid,p_payment_id text,p_cash_minor bigint,p_currency text,p_paid_at timestamptz
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE t public.membership_fee_token%ROWTYPE;
 s public.membership_voucher_settlement%ROWTYPE;
 r public.membership_post_grace_renewal%ROWTYPE;
 h public.member_membership_history%ROWTYPE;
 snapshot jsonb; expected jsonb; cols text; vals text; proof_time timestamptz; provider text; reference text;
BEGIN
 SELECT * INTO t FROM public.membership_fee_token WHERE id=p_token_id AND tenant_id=p_tenant_id;
 IF NOT FOUND OR t.member_id IS NULL OR t.organization_id IS NOT NULL THEN
  RAISE EXCEPTION 'Member credit checkout required';
 END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('rolling:'||p_tenant_id::text||':member_id:'||t.member_id::text,0));
 SELECT * INTO t FROM public.membership_fee_token WHERE id=p_token_id AND tenant_id=p_tenant_id FOR UPDATE;
 SELECT * INTO s FROM public.membership_voucher_settlement WHERE fee_token_id=t.id
  AND tenant_id=p_tenant_id AND state<>'released' FOR UPDATE;
 IF NOT FOUND OR (s.funding->>'remainingMinor')::bigint IS DISTINCT FROM p_cash_minor
  OR s.funding->>'currency' IS DISTINCT FROM p_currency
  OR (p_cash_minor>0 AND (p_payment_id IS NULL OR p_payment_id IS DISTINCT FROM s.provider_payment_id OR p_paid_at IS NULL))
  OR (p_cash_minor=0 AND p_payment_id IS NOT NULL) THEN
  RAISE EXCEPTION 'Confirmed cash does not match reserved membership funding';
 END IF;
 SELECT * INTO r FROM public.membership_post_grace_renewal WHERE tenant_id=p_tenant_id AND member_id=t.member_id
  AND election_id=(t.cost_breakdown#>>'{formVoucher,electionId}')::uuid FOR UPDATE;
 IF NOT FOUND OR r.status='released' THEN RAISE EXCEPTION 'Restart reservation unavailable'; END IF;
 IF s.history_record_id IS NULL THEN
  snapshot:=(s.history_snapshot-'id'-'__accounting'-'paid_at'-'stripe_payment_intent_id')
   ||jsonb_build_object('status','pending_payment_setup','payment_status','unpaid');
  IF snapshot->>'member_id' IS DISTINCT FROM t.member_id::text
   OR snapshot->>'tenant_id' IS DISTINCT FROM p_tenant_id::text
   OR snapshot->>'membership_successor_election_id' IS DISTINCT FROM r.election_id::text THEN
   RAISE EXCEPTION 'Pending history ownership mismatch';
  END IF;
  SELECT string_agg(format('%I',key),','),string_agg(format('(jsonb_populate_record(NULL::public.member_membership_history,$1)).%I',key),',')
   INTO cols,vals FROM jsonb_each(snapshot);
  EXECUTE format('INSERT INTO public.member_membership_history(%s) SELECT %s RETURNING *',cols,vals) INTO h USING snapshot;
  UPDATE public.membership_voucher_settlement SET history_record_id=h.id WHERE id=s.id;
  UPDATE public.membership_fee_token SET history_record_id=h.id WHERE id=t.id;
  s.history_record_id:=h.id;
 ELSE
  SELECT * INTO h FROM public.member_membership_history WHERE id=s.history_record_id
   AND tenant_id=p_tenant_id AND member_id=t.member_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Pending history is unavailable'; END IF;
 END IF;
 SELECT before_rows INTO expected FROM public.membership_post_grace_date_application
  WHERE reservation_id=r.id AND tenant_id=p_tenant_id AND member_id=t.member_id AND state='applied';
 IF NOT FOUND THEN expected:=jsonb_build_object('history',to_jsonb(h),'agreement',NULL,'plan',NULL); END IF;
 provider:=CASE WHEN p_cash_minor=0 THEN 'credit' ELSE 'stripe' END;
 reference:=CASE WHEN p_cash_minor=0 THEN 'voucher:'||s.id::text ELSE p_payment_id END;
 IF p_cash_minor=0 THEN
  SELECT paid_at INTO proof_time FROM public.membership_post_grace_funding_evidence WHERE reservation_id=r.id;
  proof_time:=coalesce(proof_time,now());
 ELSE proof_time:=p_paid_at;
 END IF;
 PERFORM public.apply_post_grace_funded_dates(p_tenant_id,t.member_id,r.id,s.id,provider,reference,
  CASE WHEN p_cash_minor=0 THEN 'fully_allocated' ELSE 'succeeded' END,proof_time,p_cash_minor,p_currency,expected);
 RETURN public.membership_voucher_complete(p_tenant_id,t.id,p_payment_id,p_cash_minor,p_currency);
END $$;
REVOKE ALL ON FUNCTION public.complete_post_grace_membership_voucher(uuid,uuid,text,bigint,text,timestamptz)
 FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.complete_post_grace_membership_voucher(uuid,uuid,text,bigint,text,timestamptz) TO service_role;

-- Internal zero-cash variable collections are financial events too. Their
-- ledger consumption and first-service dates must commit or roll back together.
ALTER FUNCTION public.membership_variable_voucher_settle_collection(uuid,uuid)
 RENAME TO membership_variable_voucher_settle_before_restart_dates;
REVOKE ALL ON FUNCTION public.membership_variable_voucher_settle_before_restart_dates(uuid,uuid)
 FROM PUBLIC,anon,authenticated,service_role;
CREATE FUNCTION public.membership_variable_voucher_settle_collection(p_tenant_id uuid,p_reservation_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE result jsonb; s public.membership_voucher_settlement%ROWTYPE;
 v public.membership_variable_voucher_slice%ROWTYPE;
 r public.membership_post_grace_renewal%ROWTYPE;
 h jsonb; a jsonb; p jsonb; expected jsonb;
BEGIN
 -- Acquire the same owner lock before the underlying voucher ledger locks.
 SELECT s0.* INTO s FROM public.membership_variable_voucher_slice v0
 JOIN public.membership_voucher_settlement s0 ON s0.id=v0.settlement_id
 WHERE v0.tenant_id=p_tenant_id AND s0.tenant_id=p_tenant_id AND v0.reservation_id=p_reservation_id;
 SELECT r0.* INTO r FROM public.form_membership_voucher_checkout b
 JOIN public.membership_post_grace_renewal r0 ON r0.election_id=b.election_id
 WHERE b.fee_token_id=s.fee_token_id AND b.tenant_id=p_tenant_id AND b.released_at IS NULL
  AND r0.tenant_id=p_tenant_id AND r0.member_id=b.member_id;
 IF FOUND THEN
  PERFORM pg_advisory_xact_lock(hashtextextended('rolling:'||p_tenant_id::text||':member_id:'||r.member_id::text,0));
 END IF;
 result:=public.membership_variable_voucher_settle_before_restart_dates(p_tenant_id,p_reservation_id);
 IF r.id IS NULL THEN RETURN result; END IF;
 SELECT * INTO v FROM public.membership_variable_voucher_slice
  WHERE reservation_id=p_reservation_id AND tenant_id=p_tenant_id FOR UPDATE;
 IF v.ordinal<>1 THEN RETURN result; END IF;
 SELECT before_rows INTO expected FROM public.membership_post_grace_date_application
  WHERE reservation_id=r.id AND tenant_id=p_tenant_id AND state='applied';
 IF FOUND THEN RETURN result; END IF;
 IF v.cash_minor<>0 THEN
  RAISE EXCEPTION 'Finalize confirmed cash dates before consuming first-collection credit';
 END IF;
 SELECT to_jsonb(x) INTO h FROM public.member_membership_history x
  WHERE id=s.history_record_id AND tenant_id=p_tenant_id AND member_id=r.member_id FOR UPDATE;
 SELECT to_jsonb(x) INTO a FROM public.membership_billing_agreements x
  WHERE id=s.billing_agreement_id AND tenant_id=p_tenant_id AND member_id=r.member_id FOR UPDATE;
 SELECT to_jsonb(x) INTO p FROM public.membership_payment_plans x
  WHERE billing_agreement_id=s.billing_agreement_id AND tenant_id=p_tenant_id AND member_id=r.member_id FOR UPDATE;
 IF h IS NULL OR a IS NULL OR p IS NULL THEN RAISE EXCEPTION 'First credit collection records unavailable'; END IF;
 expected:=jsonb_build_object('history',h,'agreement',a,'plan',p);
 PERFORM public.apply_post_grace_funded_dates(p_tenant_id,r.member_id,r.id,s.id,'credit',
  'variable-voucher:'||p_reservation_id::text,'fully_allocated',v.settled_at,0,r.currency,expected);
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION public.membership_variable_voucher_settle_collection(uuid,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.membership_variable_voucher_settle_collection(uuid,uuid) TO service_role;

-- Extend only the reviewed proof checks; fail migration rather than silently
-- replacing an evolved function with an older definition.
DO $patch$
DECLARE definition text; marker text; replacement text;
BEGIN
 definition:=pg_get_functiondef('public.record_post_grace_payment(uuid,uuid,uuid,text,text,text,timestamptz,bigint,text)'::regprocedure);
 marker:='p_amount_minor IS DISTINCT FROM r.first_payment_minor';
 replacement:=$r$p_amount_minor IS DISTINCT FROM coalesce((SELECT f.gross_minor
  FROM public.membership_post_grace_funding_evidence f WHERE f.reservation_id=r.id
   AND f.tenant_id=p_tenant_id AND f.member_id=p_member_id AND f.provider=p_provider
   AND f.payment_id=p_payment_id AND f.paid_at=p_paid_at),r.first_payment_minor)$r$;
 IF (length(definition)-length(replace(definition,marker,'')))/length(marker)<>1 THEN
  RAISE EXCEPTION 'Unexpected post-grace amount contract';
 END IF;
 definition:=replace(definition,marker,replacement);
 marker:=$m$r.payment_method='upfront'$m$;
 replacement:=$r$(r.payment_method='upfront' OR EXISTS(SELECT FROM public.membership_post_grace_funding_evidence f
  WHERE f.reservation_id=r.id AND f.tenant_id=p_tenant_id AND f.member_id=p_member_id
   AND f.provider='credit' AND f.payment_id=p_payment_id AND f.paid_at=p_paid_at AND f.cash_minor=0))$r$;
 IF (length(definition)-length(replace(definition,marker,'')))/length(marker)<>2 THEN
  RAISE EXCEPTION 'Unexpected post-grace credit contract';
 END IF;
 EXECUTE replace(definition,marker,replacement);
 definition:=pg_get_functiondef('public.apply_post_grace_record_dates(uuid,uuid,uuid,text,text,text,timestamptz,bigint,text,jsonb)'::regprocedure);
 marker:=$m$IF r.payment_method<>'upfront' THEN$m$;
 replacement:=$r$IF r.payment_method<>'upfront' AND NOT EXISTS(SELECT FROM public.membership_post_grace_funding_evidence f
  WHERE f.reservation_id=r.id AND f.full_term_credit AND f.provider='credit') THEN$r$;
 IF (length(definition)-length(replace(definition,marker,'')))/length(marker)<>1 THEN
  RAISE EXCEPTION 'Unexpected post-grace agreement contract';
 END IF;
 definition:=replace(definition,marker,replacement);
 marker:=$m$a->>'provider' IS DISTINCT FROM p_provider$m$;
 replacement:=$r$a->>'provider' IS DISTINCT FROM (CASE WHEN p_provider='credit'
  THEN CASE r.payment_method WHEN 'monthly_card' THEN 'stripe' WHEN 'direct_debit' THEN 'gocardless' END
  ELSE p_provider END)$r$;
 IF (length(definition)-length(replace(definition,marker,'')))/length(marker)<>1 THEN
  RAISE EXCEPTION 'Unexpected post-grace provider contract';
 END IF;
 EXECUTE replace(definition,marker,replacement);
END $patch$;
COMMIT;
