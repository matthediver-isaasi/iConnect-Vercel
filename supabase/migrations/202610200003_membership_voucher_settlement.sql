-- Task 5241: token purchase + shared voucher lifecycle in one transaction.
-- No direct voucher balance writes; the shared RPC owns reservations/ledger.
CREATE TABLE public.membership_payment_term_claim (
 tenant_id uuid NOT NULL, owner_type text NOT NULL, owner_id uuid NOT NULL,
 membership_year text NOT NULL, source_key text NOT NULL, rail text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,owner_type,owner_id,membership_year)
);
ALTER TABLE public.membership_payment_term_claim ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.membership_payment_term_claim FROM PUBLIC,anon,authenticated;
GRANT SELECT ON public.membership_payment_term_claim TO service_role;
CREATE POLICY membership_payment_term_claim_service ON public.membership_payment_term_claim TO service_role USING(true);
CREATE FUNCTION public.membership_payment_term_guard(
 p_tenant_id uuid,p_member_id uuid,p_organization_id uuid,p_year text,p_source_key text,p_rail text
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_owner_type text; v_owner_id uuid; claim public.membership_payment_term_claim%ROWTYPE;
BEGIN
 IF num_nonnulls(p_member_id,p_organization_id)<>1 OR nullif(p_year,'') IS NULL OR nullif(p_source_key,'') IS NULL
   OR p_rail NOT IN ('voucher','create_payment','start_monthly_card','start_direct_debit') THEN RAISE EXCEPTION 'Invalid membership payment authority'; END IF;
 v_owner_type:=CASE WHEN p_member_id IS NULL THEN 'organization' ELSE 'member' END;
 v_owner_id:=coalesce(p_member_id,p_organization_id);
 PERFORM pg_advisory_xact_lock(hashtextextended('membership-payment:'||p_tenant_id::text||':'||v_owner_type||':'||v_owner_id::text||':'||p_year,0));
 SELECT * INTO claim FROM public.membership_payment_term_claim c WHERE c.tenant_id=p_tenant_id
   AND c.owner_type=v_owner_type AND c.owner_id=v_owner_id AND c.membership_year=p_year;
 IF FOUND THEN
   IF claim.source_key<>p_source_key OR claim.rail<>p_rail THEN RAISE EXCEPTION 'Another membership payment is already committed for this term'; END IF;
   RETURN;
 END IF;
 IF p_rail='voucher' AND EXISTS(SELECT 1 FROM public.membership_billing_agreements a
   WHERE a.tenant_id=p_tenant_id AND
    (CASE WHEN p_member_id IS NOT NULL THEN a.member_id=p_member_id ELSE a.organization_id=p_organization_id END)
    AND coalesce(a.metadata->'card'->>'membership_year',a.metadata->'dd'->>'membership_year')=p_year
    AND a.status NOT IN ('cancelled','expired','failed','replaced','payment_plan_cancelled')) THEN
   RAISE EXCEPTION 'An existing monthly agreement must be reconciled before applying membership credit';
 END IF;
 INSERT INTO public.membership_payment_term_claim(tenant_id,owner_type,owner_id,membership_year,source_key,rail)
 VALUES(p_tenant_id,v_owner_type,v_owner_id,p_year,p_source_key,p_rail);
END $$;

CREATE TABLE public.membership_fee_checkout_claim (
 fee_token_id uuid PRIMARY KEY REFERENCES public.membership_fee_token(id),
 tenant_id uuid NOT NULL,
 rail text NOT NULL CHECK (rail IN ('voucher','create_payment','start_direct_debit','start_monthly_card')),
 created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.membership_fee_checkout_claim ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.membership_fee_checkout_claim FROM PUBLIC,anon,authenticated;
GRANT SELECT ON public.membership_fee_checkout_claim TO service_role;
CREATE POLICY membership_fee_checkout_claim_service ON public.membership_fee_checkout_claim TO service_role USING (true);

CREATE FUNCTION public.membership_fee_checkout_guard(p_tenant_id uuid,p_token_id uuid,p_rail text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE t public.membership_fee_token%ROWTYPE; saved_rail text;
BEGIN
 SELECT * INTO t FROM public.membership_fee_token WHERE id=p_token_id AND tenant_id=p_tenant_id FOR UPDATE;
 IF NOT FOUND OR t.status<>'pending' OR t.expires_at<=now() THEN RAISE EXCEPTION 'Membership checkout is unavailable'; END IF;
 IF p_rail NOT IN ('voucher','create_payment','start_direct_debit','start_monthly_card') THEN RAISE EXCEPTION 'Invalid payment rail'; END IF;
 INSERT INTO public.membership_fee_checkout_claim(fee_token_id,tenant_id,rail)
 VALUES(t.id,t.tenant_id,p_rail) ON CONFLICT DO NOTHING;
 SELECT rail INTO saved_rail FROM public.membership_fee_checkout_claim WHERE fee_token_id=t.id;
 IF saved_rail IS DISTINCT FROM p_rail THEN RAISE EXCEPTION 'Another payment method has already started for this membership'; END IF;
 PERFORM public.membership_payment_term_guard(t.tenant_id,t.member_id,t.organization_id,t.membership_year,'fee:'||t.id::text,p_rail);
END $$;

CREATE TABLE public.membership_voucher_settlement (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  fee_token_id uuid NOT NULL REFERENCES public.membership_fee_token(id),
  quote_id uuid NOT NULL REFERENCES public.membership_voucher_quote(id),
  purchase_key text NOT NULL UNIQUE,
  funding jsonb NOT NULL,
  history_snapshot jsonb NOT NULL,
  state text NOT NULL DEFAULT 'reserved' CHECK (state IN ('reserved','provider_pending','committed','released')),
  provider_payment_id text,
  provider_attempted_at timestamptz,
  history_record_id uuid,
  accounting_status text NOT NULL DEFAULT 'pending' CHECK (accounting_status IN ('pending','complete','failed')),
  accounting_error text,
  accounting_provider text,
  accounting_attempted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX membership_voucher_active_token ON public.membership_voucher_settlement(fee_token_id) WHERE state<>'released';
ALTER TABLE public.membership_voucher_settlement ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.membership_voucher_settlement FROM anon, authenticated;
GRANT SELECT, UPDATE ON public.membership_voucher_settlement TO service_role;
CREATE POLICY membership_voucher_settlement_service ON public.membership_voucher_settlement
  TO service_role USING (true) WITH CHECK (true);

CREATE FUNCTION public.membership_voucher_reserve(
  p_tenant_id uuid, p_token_id uuid, p_quote_id uuid, p_fingerprint text, p_history_snapshot jsonb,
  p_authenticated_member_id uuid DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE t public.membership_fee_token%ROWTYPE; q public.membership_voucher_quote%ROWTYPE;
 s public.membership_voucher_settlement%ROWTYPE; funding jsonb; ids uuid[]; gross bigint; key text;
BEGIN
 SELECT * INTO t FROM public.membership_fee_token WHERE id=p_token_id AND tenant_id=p_tenant_id FOR UPDATE;
 IF NOT FOUND OR num_nonnulls(t.member_id,t.organization_id)<>1 THEN RAISE EXCEPTION 'Membership token owner required'; END IF;
 SELECT * INTO s FROM public.membership_voucher_settlement WHERE fee_token_id=t.id AND state<>'released' FOR UPDATE;
 IF FOUND THEN
   IF s.quote_id<>p_quote_id OR s.state='released' THEN RAISE EXCEPTION 'A different credit commitment already exists'; END IF;
   RETURN to_jsonb(s);
 END IF;
 IF t.status<>'pending' OR t.expires_at<=now() OR t.stripe_payment_intent_id IS NOT NULL THEN
   RAISE EXCEPTION 'Membership payment has already started or token expired';
 END IF;
 IF to_jsonb(t)->>'stripe_payment_attempted_at' IS NOT NULL THEN RAISE EXCEPTION 'A previous cash payment needs reconciliation'; END IF;
 PERFORM public.membership_fee_checkout_guard(p_tenant_id,p_token_id,'voucher');
 SELECT * INTO q FROM public.membership_voucher_quote WHERE id=p_quote_id AND tenant_id=p_tenant_id
   AND fee_token_id=t.id AND member_id IS NOT DISTINCT FROM t.member_id AND organization_id IS NOT DISTINCT FROM t.organization_id;
 IF NOT FOUND OR q.expires_at<=now() OR q.fingerprint<>p_fingerprint THEN RAISE EXCEPTION 'Credit quote is stale; review again'; END IF;
 IF (q.quote->>'tokenUpdatedAt')::timestamptz IS DISTINCT FROM t.updated_at THEN
   RAISE EXCEPTION 'Membership purchase changed; review credit again';
 END IF;
 IF q.authenticated_member_id IS NOT NULL AND q.authenticated_member_id IS DISTINCT FROM p_authenticated_member_id THEN
   RAISE EXCEPTION 'Sign in again with the organisation authority that accepted this quote';
 END IF;
 IF t.organization_id IS NOT NULL AND NOT EXISTS(
   SELECT 1 FROM public.member WHERE id=p_authenticated_member_id AND tenant_id=p_tenant_id AND organization_id=t.organization_id
 ) THEN RAISE EXCEPTION 'Authenticated organisation credit authority required'; END IF;
 gross:=round(coalesce((t.cost_breakdown->>'totalWithVat')::numeric,t.final_cost)*100)::bigint;
 IF gross<>(q.quote->>'grossMinor')::bigint OR upper(coalesce(t.currency,'GBP'))<>q.quote->>'currency' THEN
   RAISE EXCEPTION 'Membership fee changed; review again';
 END IF;
 SELECT array_agg((a->>'voucherId')::uuid ORDER BY ord) INTO ids
   FROM jsonb_array_elements(q.quote->'allocations') WITH ORDINALITY AS a(a,ord);
 IF coalesce(array_length(ids,1),0)=0 THEN RAISE EXCEPTION 'Select personal credit first'; END IF;
 key:='membership:'||t.id::text||':'||q.id::text;
 funding:=public.voucher_credit_reserve(p_tenant_id,key,coalesce(t.member_id,p_authenticated_member_id),p_authenticated_member_id,ids,
   (q.quote->>'creditMinor')::bigint,upper(coalesce(t.currency,'GBP')),q.authenticated_member_id IS NOT NULL,false);
 IF (funding->>'voucherMinor')::bigint<>(q.quote->>'creditMinor')::bigint THEN
   RAISE EXCEPTION 'Credit balance changed; review again';
 END IF;
 funding:=funding||jsonb_build_object('payableMinor',gross,'remainingMinor',gross-(funding->>'voucherMinor')::bigint);
 IF p_history_snapshot->>'member_id' IS DISTINCT FROM t.member_id::text
   OR p_history_snapshot->>'organization_id' IS DISTINCT FROM t.organization_id::text
   OR p_history_snapshot->>'tenant_id' IS DISTINCT FROM t.tenant_id::text
   OR p_history_snapshot->>'membership_year' IS DISTINCT FROM t.membership_year
   OR round(coalesce((p_history_snapshot->>'total_with_vat')::numeric,(p_history_snapshot->>'final_cost')::numeric)*100)::bigint IS DISTINCT FROM gross
 THEN RAISE EXCEPTION 'Membership history snapshot does not match purchase'; END IF;
 INSERT INTO public.membership_voucher_settlement(tenant_id,fee_token_id,quote_id,purchase_key,funding,history_snapshot,history_record_id)
 VALUES(p_tenant_id,t.id,q.id,key,funding,p_history_snapshot,t.history_record_id) RETURNING * INTO s;
 RETURN to_jsonb(s);
END $$;

CREATE FUNCTION public.membership_voucher_complete(
 p_tenant_id uuid,p_token_id uuid,p_payment_id text,p_cash_minor bigint,p_currency text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE t public.membership_fee_token%ROWTYPE; s public.membership_voucher_settlement%ROWTYPE;
 h record; snapshot jsonb; cols text; vals text; history_table text; owner_column text; owner_id uuid;
BEGIN
 SELECT * INTO t FROM public.membership_fee_token WHERE id=p_token_id AND tenant_id=p_tenant_id FOR UPDATE;
 SELECT * INTO s FROM public.membership_voucher_settlement WHERE fee_token_id=t.id AND tenant_id=p_tenant_id AND state<>'released' FOR UPDATE;
 IF NOT FOUND OR s.state='released' THEN RAISE EXCEPTION 'Credit commitment unavailable'; END IF;
 IF p_cash_minor IS DISTINCT FROM (s.funding->>'remainingMinor')::bigint
   OR upper(p_currency) IS DISTINCT FROM s.funding->>'currency'
   OR (p_cash_minor>0 AND (p_payment_id IS NULL OR p_payment_id IS DISTINCT FROM s.provider_payment_id))
   OR (p_cash_minor=0 AND p_payment_id IS NOT NULL) THEN RAISE EXCEPTION 'Cash evidence does not match credit commitment'; END IF;
 IF s.state='committed' THEN RETURN to_jsonb(s); END IF;
 IF t.status NOT IN ('pending','paid','expired') THEN RAISE EXCEPTION 'Membership token cannot be completed'; END IF;
 history_table:=CASE WHEN t.member_id IS NOT NULL THEN 'member_membership_history' ELSE 'organisation_membership_history' END;
 owner_column:=CASE WHEN t.member_id IS NOT NULL THEN 'member_id' ELSE 'organization_id' END;
 owner_id:=coalesce(t.member_id,t.organization_id);
 IF s.history_record_id IS NOT NULL THEN
   EXECUTE format('SELECT * FROM public.%I WHERE id=$1 AND tenant_id=$2 AND %I=$3 FOR UPDATE',history_table,owner_column)
     INTO h USING s.history_record_id,p_tenant_id,owner_id;
   IF h.id IS NULL OR h.payment_status IN ('paid','unverified','voided')
     OR round(coalesce(h.total_with_vat,h.final_cost)*100)::bigint<>(s.funding->>'payableMinor')::bigint
     THEN RAISE EXCEPTION 'Existing membership requires financial review'; END IF;
 ELSE
   -- Snapshot fields are supplied only by the service-role trusted simulator.
   -- Preserve DB defaults by inserting only explicit fields, not a whole record.
   snapshot:=s.history_snapshot - 'id' - 'payment_status' - 'paid_at' - 'stripe_payment_intent_id' - '__accounting';
   SELECT string_agg(format('%I',key),','),string_agg(format('(jsonb_populate_record(NULL::public.%I,$1)).%I',history_table,key),',')
     INTO cols,vals FROM jsonb_each(snapshot);
   EXECUTE format('INSERT INTO public.%I(%s) SELECT %s RETURNING *',history_table,cols,vals) INTO h USING snapshot;
 END IF;
 PERFORM public.voucher_credit_transition(p_tenant_id,s.purchase_key,'commit',NULL);
 EXECUTE format('UPDATE public.%I SET payment_status=''paid'',paid_at=now(),
   status=CASE WHEN term_start_date>current_date THEN ''scheduled'' ELSE ''active'' END,
   scheduled_activation_date=CASE WHEN term_start_date>current_date THEN term_start_date ELSE NULL END,
   stripe_payment_intent_id=$1,
   payment_method=CASE WHEN $2>0 THEN ''stripe'' ELSE NULL END,
   accounting_sync_status=''retrying'',
   accounting_sync_error=''Voucher funding settlement awaiting accounting reconciliation''
   WHERE id=$3',history_table) USING p_payment_id,p_cash_minor,h.id;
 UPDATE public.membership_fee_token SET status='paid',paid_at=now(),history_record_id=h.id,
   stripe_payment_intent_id=p_payment_id,updated_at=now() WHERE id=t.id;
 UPDATE public.membership_voucher_settlement SET state='committed',history_record_id=h.id,
   updated_at=now() WHERE id=s.id RETURNING * INTO s;
 RETURN to_jsonb(s);
END $$;

CREATE FUNCTION public.membership_voucher_release(p_tenant_id uuid,p_token_id uuid,p_payment_id text,p_outcome text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE t public.membership_fee_token%ROWTYPE; s public.membership_voucher_settlement%ROWTYPE;
BEGIN
 SELECT * INTO t FROM public.membership_fee_token WHERE id=p_token_id AND tenant_id=p_tenant_id FOR UPDATE;
 SELECT * INTO s FROM public.membership_voucher_settlement WHERE fee_token_id=t.id AND state<>'released' FOR UPDATE;
 IF NOT FOUND THEN RETURN jsonb_build_object('released',true); END IF;
 IF s.state='committed' OR t.status='paid' THEN RAISE EXCEPTION 'Paid membership cannot release credit'; END IF;
 IF p_outcome='not_started' AND s.provider_attempted_at IS NULL AND s.provider_payment_id IS NULL THEN NULL;
 ELSIF p_outcome='cancelled' AND p_payment_id IS NOT NULL AND p_payment_id=s.provider_payment_id THEN NULL;
 ELSE RAISE EXCEPTION 'Reconcile the provider outcome before releasing membership credit'; END IF;
 PERFORM public.voucher_credit_transition(p_tenant_id,s.purchase_key,'release',p_outcome);
 UPDATE public.membership_voucher_settlement SET state='released',updated_at=now() WHERE id=s.id;
 UPDATE public.membership_fee_token SET stripe_payment_intent_id=NULL,stripe_client_secret=NULL,updated_at=now() WHERE id=t.id;
 DELETE FROM public.membership_fee_checkout_claim WHERE fee_token_id=t.id AND rail='voucher';
 DELETE FROM public.membership_payment_term_claim WHERE tenant_id=t.tenant_id
   AND source_key='fee:'||t.id::text AND rail='voucher';
 RETURN jsonb_build_object('released',true);
END $$;

REVOKE ALL ON FUNCTION public.membership_voucher_reserve(uuid,uuid,uuid,text,jsonb,uuid),
 public.membership_payment_term_guard(uuid,uuid,uuid,text,text,text),
 public.membership_fee_checkout_guard(uuid,uuid,text),
 public.membership_voucher_complete(uuid,uuid,text,bigint,text),
 public.membership_voucher_release(uuid,uuid,text,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.membership_voucher_reserve(uuid,uuid,uuid,text,jsonb,uuid),
 public.membership_payment_term_guard(uuid,uuid,uuid,text,text,text),
 public.membership_fee_checkout_guard(uuid,uuid,text),
 public.membership_voucher_complete(uuid,uuid,text,bigint,text),
 public.membership_voucher_release(uuid,uuid,text,text) TO service_role;
