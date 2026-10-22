-- Finite purchased-term funding. Application/test rollout only; no live writes.
ALTER TABLE public.membership_voucher_settlement DROP CONSTRAINT membership_voucher_settlement_state_check;
ALTER TABLE public.membership_voucher_settlement ADD CONSTRAINT membership_voucher_settlement_state_check
 CHECK(state IN ('reserved','provider_pending','plan_committed','committed','released'));
ALTER TABLE public.membership_voucher_settlement ADD COLUMN monthly_snapshot jsonb;
ALTER TABLE public.membership_voucher_settlement ADD COLUMN billing_agreement_id uuid;
CREATE TABLE public.membership_voucher_collection (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL, settlement_id uuid NOT NULL REFERENCES public.membership_voucher_settlement(id),
 ordinal integer NOT NULL CHECK(ordinal>0), external_reference text NOT NULL,
 provider text NOT NULL CHECK(provider IN ('stripe','gocardless','voucher')),
 cash_minor bigint NOT NULL CHECK(cash_minor>=0),
 collection_date date NOT NULL DEFAULT current_date,
 accounting_provider text, accounting_invoice_id text, accounting_invoice_number text,
 accounting_status text NOT NULL DEFAULT 'pending',
 accounting_attempted_at timestamptz, accounting_error text,
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(settlement_id,ordinal), UNIQUE(tenant_id,provider,external_reference)
);
ALTER TABLE public.membership_voucher_collection ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.membership_voucher_collection FROM PUBLIC,anon,authenticated;
GRANT SELECT,UPDATE ON public.membership_voucher_collection TO service_role;
CREATE POLICY membership_voucher_collection_service ON public.membership_voucher_collection TO service_role USING(true) WITH CHECK(true);

CREATE FUNCTION public.membership_voucher_prepare_monthly(p_tenant_id uuid,p_token_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE t public.membership_fee_token%ROWTYPE; s public.membership_voucher_settlement%ROWTYPE;
 q public.membership_voucher_quote%ROWTYPE; h public.member_membership_history%ROWTYPE;
 snapshot jsonb; cols text; vals text; n integer;
BEGIN
 SELECT * INTO t FROM public.membership_fee_token WHERE id=p_token_id AND tenant_id=p_tenant_id FOR UPDATE;
 IF t.member_id IS NULL OR t.organization_id IS NOT NULL THEN RAISE EXCEPTION 'Monthly funding requires an individual membership'; END IF;
 SELECT * INTO s FROM public.membership_voucher_settlement WHERE fee_token_id=t.id AND state<>'released' FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Membership credit reservation missing'; END IF;
 IF s.monthly_snapshot IS NOT NULL THEN RETURN to_jsonb(s); END IF;
 SELECT * INTO q FROM public.membership_voucher_quote WHERE id=s.quote_id;
 snapshot:=q.quote->'monthlySnapshot';
 n:=(snapshot->>'instalment_count')::integer;
 IF snapshot IS NULL OR n IS NULL OR n<1 OR n>120
   OR snapshot->>'payment_mode' NOT IN ('stripe_monthly','direct_debit')
   OR (s.funding->>'remainingMinor')::bigint%n<>0
   OR round((snapshot->>'plan_total')::numeric*100)::bigint<>(s.funding->>'payableMinor')::bigint
 THEN RAISE EXCEPTION 'Invalid finite monthly credit quote'; END IF;
 IF s.history_record_id IS NOT NULL THEN
   SELECT * INTO h FROM public.member_membership_history WHERE id=s.history_record_id AND tenant_id=p_tenant_id AND member_id=t.member_id FOR UPDATE;
   IF NOT FOUND OR h.payment_status IN ('paid','unverified','voided')
    OR round(coalesce(h.total_with_vat,h.final_cost)*100)::bigint<>(s.funding->>'payableMinor')::bigint
   THEN RAISE EXCEPTION 'Existing membership is not the quoted monthly obligation'; END IF;
 ELSE
   snapshot:=s.history_snapshot - 'id' - '__accounting' - 'paid_at' - 'stripe_payment_intent_id'
    ||jsonb_build_object('status','pending_payment_setup','payment_status','unpaid');
   SELECT string_agg(format('%I',key),','),string_agg(format('(jsonb_populate_record(NULL::public.member_membership_history,$1)).%I',key),',')
    INTO cols,vals FROM jsonb_each(snapshot);
   EXECUTE format('INSERT INTO public.member_membership_history(%s) SELECT %s RETURNING *',cols,vals) INTO h USING snapshot;
 END IF;
 UPDATE public.membership_voucher_settlement SET monthly_snapshot=q.quote->'monthlySnapshot',history_record_id=h.id,updated_at=now()
  WHERE id=s.id RETURNING * INTO s;
 UPDATE public.member_membership_history SET billing_period=
  CASE WHEN s.monthly_snapshot->>'payment_mode'='stripe_monthly' THEN 'monthly_card' ELSE 'monthly_direct_debit' END
  WHERE id=h.id AND tenant_id=p_tenant_id;
 UPDATE public.membership_fee_token SET history_record_id=h.id,updated_at=now() WHERE id=t.id;
 RETURN to_jsonb(s);
END $$;

CREATE FUNCTION public.membership_voucher_commit_monthly(p_tenant_id uuid,p_settlement_id uuid,p_agreement_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE s public.membership_voucher_settlement%ROWTYPE; a public.membership_billing_agreements%ROWTYPE; snap jsonb;
BEGIN
 SELECT * INTO s FROM public.membership_voucher_settlement WHERE id=p_settlement_id AND tenant_id=p_tenant_id FOR UPDATE;
 IF NOT FOUND OR s.state='released' OR s.monthly_snapshot IS NULL THEN RAISE EXCEPTION 'Monthly credit commitment missing'; END IF;
 SELECT * INTO a FROM public.membership_billing_agreements WHERE id=p_agreement_id AND tenant_id=p_tenant_id;
 snap:=coalesce(a.metadata->'card',a.metadata->'dd');
 IF NOT FOUND OR snap->'voucher_funding'->>'settlement_id' IS DISTINCT FROM s.id::text
  OR a.member_id::text IS DISTINCT FROM s.history_snapshot->>'member_id'
  OR (snap->>'monthly_amount_minor')::bigint IS DISTINCT FROM
   (s.funding->>'remainingMinor')::bigint/(s.monthly_snapshot->>'instalment_count')::integer
  OR snap->>'currency' IS DISTINCT FROM s.funding->>'currency'
  OR snap->>'membership_year' IS DISTINCT FROM s.history_snapshot->>'membership_year'
  OR (s.billing_agreement_id IS NOT NULL AND s.billing_agreement_id<>a.id)
 THEN RAISE EXCEPTION 'Monthly agreement does not match accepted credit commitment'; END IF;
 IF s.state='committed' THEN RETURN to_jsonb(s); END IF;
 PERFORM public.voucher_credit_transition(p_tenant_id,s.purchase_key,'commit',NULL);
 UPDATE public.membership_voucher_settlement SET state='plan_committed',billing_agreement_id=a.id,updated_at=now()
  WHERE id=s.id AND state<>'committed' RETURNING * INTO s;
 UPDATE public.member_membership_history SET billing_agreement_id=a.id,
  payment_method=CASE WHEN s.monthly_snapshot->>'payment_mode'='stripe_monthly' THEN 'card_monthly' ELSE 'direct_debit' END,
  billing_period=CASE WHEN s.monthly_snapshot->>'payment_mode'='stripe_monthly' THEN 'monthly_card' ELSE 'monthly_direct_debit' END
  WHERE id=s.history_record_id AND tenant_id=p_tenant_id;
 RETURN to_jsonb(s);
END $$;

CREATE FUNCTION public.membership_voucher_claim_collection(
 p_tenant_id uuid,p_settlement_id uuid,p_provider text,p_reference text,p_cash_minor bigint,p_collection_date date DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE s public.membership_voucher_settlement%ROWTYPE; c public.membership_voucher_collection%ROWTYPE; n integer; next_n integer;
BEGIN
 SELECT * INTO s FROM public.membership_voucher_settlement WHERE id=p_settlement_id AND tenant_id=p_tenant_id FOR UPDATE;
 IF NOT FOUND OR s.state NOT IN ('plan_committed','committed') THEN RAISE EXCEPTION 'Monthly funding is not committed'; END IF;
 n:=(s.monthly_snapshot->>'instalment_count')::integer;
 IF n IS NULL OR p_cash_minor IS DISTINCT FROM (s.funding->>'remainingMinor')::bigint/n
  OR p_provider IS DISTINCT FROM (CASE WHEN p_cash_minor=0 THEN 'voucher'
    WHEN s.monthly_snapshot->>'payment_mode'='stripe_monthly' THEN 'stripe' ELSE 'gocardless' END)
  OR (p_provider='voucher' AND p_collection_date IS NULL)
  OR (p_provider<>'voucher' AND p_collection_date IS NOT NULL)
  OR nullif(p_reference,'') IS NULL THEN RAISE EXCEPTION 'Collection does not match frozen membership schedule'; END IF;
 SELECT * INTO c FROM public.membership_voucher_collection WHERE tenant_id=p_tenant_id AND provider=p_provider AND external_reference=p_reference;
 IF FOUND THEN
  IF c.settlement_id<>s.id OR c.cash_minor<>p_cash_minor
    OR (p_collection_date IS NOT NULL AND c.collection_date<>p_collection_date)
  THEN RAISE EXCEPTION 'Collection is bound to a different purchase'; END IF;
  RETURN to_jsonb(c);
 END IF;
 SELECT coalesce(max(ordinal),0)+1 INTO next_n FROM public.membership_voucher_collection WHERE settlement_id=s.id;
 IF next_n>n THEN RAISE EXCEPTION 'All purchased-term instalments already have cash evidence'; END IF;
 INSERT INTO public.membership_voucher_collection(tenant_id,settlement_id,ordinal,external_reference,provider,cash_minor,collection_date,accounting_status)
 VALUES(p_tenant_id,s.id,next_n,p_reference,p_provider,p_cash_minor,coalesce(p_collection_date,current_date),
  CASE WHEN p_collection_date>current_date THEN 'scheduled' ELSE 'pending' END) RETURNING * INTO c;
 IF next_n=n THEN
  UPDATE public.membership_voucher_settlement SET state='committed',updated_at=now() WHERE id=s.id;
  UPDATE public.membership_fee_token SET status='paid',paid_at=coalesce(paid_at,now()),updated_at=now() WHERE id=s.fee_token_id;
 END IF;
 RETURN to_jsonb(c);
END $$;
CREATE FUNCTION public.membership_voucher_release_monthly(
 p_tenant_id uuid,p_settlement_id uuid,p_agreement_id uuid,p_provider_reference text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE s public.membership_voucher_settlement%ROWTYPE; a public.membership_billing_agreements%ROWTYPE;
BEGIN
 SELECT * INTO s FROM public.membership_voucher_settlement WHERE id=p_settlement_id AND tenant_id=p_tenant_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Monthly credit commitment unavailable'; END IF;
 IF s.state='released' THEN RETURN jsonb_build_object('released',true); END IF;
 IF s.state NOT IN ('reserved','provider_pending') THEN RAISE EXCEPTION 'Committed membership must use its cancellation policy'; END IF;
 IF p_agreement_id IS NOT NULL THEN
  SELECT * INTO a FROM public.membership_billing_agreements WHERE id=p_agreement_id AND tenant_id=p_tenant_id FOR UPDATE;
  IF NOT FOUND OR coalesce(a.metadata->'card',a.metadata->'dd')->'voucher_funding'->>'settlement_id' IS DISTINCT FROM s.id::text
    OR p_provider_reference IS NULL OR p_provider_reference IS DISTINCT FROM
      (CASE WHEN s.monthly_snapshot->>'payment_mode'='stripe_monthly' THEN a.stripe_checkout_session_id ELSE a.gocardless_billing_request_id END)
  THEN RAISE EXCEPTION 'Cancelled provider flow does not match monthly commitment'; END IF;
  UPDATE public.membership_billing_agreements SET status='payment_plan_cancelled',updated_at=now() WHERE id=a.id;
 ELSIF s.provider_attempted_at IS NOT NULL THEN
  RAISE EXCEPTION 'Reconcile uncertain provider outcome before releasing credit';
 END IF;
 PERFORM public.voucher_credit_transition(p_tenant_id,s.purchase_key,'release',
  CASE WHEN p_provider_reference IS NULL THEN 'not_started' ELSE 'cancelled' END);
 UPDATE public.membership_voucher_settlement SET state='released',updated_at=now() WHERE id=s.id;
 UPDATE public.member_membership_history SET billing_agreement_id=NULL
  WHERE id=s.history_record_id AND tenant_id=p_tenant_id AND payment_status<>'paid';
 DELETE FROM public.membership_fee_checkout_claim WHERE fee_token_id=s.fee_token_id AND rail='voucher';
 DELETE FROM public.membership_payment_term_claim WHERE tenant_id=p_tenant_id AND source_key='fee:'||s.fee_token_id::text AND rail='voucher';
 UPDATE public.membership_fee_token SET updated_at=now() WHERE id=s.fee_token_id;
 RETURN jsonb_build_object('released',true);
END $$;

REVOKE ALL ON FUNCTION public.membership_voucher_prepare_monthly(uuid,uuid),
 public.membership_voucher_commit_monthly(uuid,uuid,uuid),
 public.membership_voucher_claim_collection(uuid,uuid,text,text,bigint,date),
 public.membership_voucher_release_monthly(uuid,uuid,uuid,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.membership_voucher_prepare_monthly(uuid,uuid),
 public.membership_voucher_commit_monthly(uuid,uuid,uuid),
 public.membership_voucher_claim_collection(uuid,uuid,text,text,bigint,date),
 public.membership_voucher_release_monthly(uuid,uuid,uuid,text) TO service_role;
