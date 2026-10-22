CREATE TABLE public.membership_fee_requote (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL,
 predecessor_token_id uuid NOT NULL UNIQUE REFERENCES public.membership_fee_token(id),
 replacement_token_id uuid NOT NULL REFERENCES public.membership_fee_token(id),
 original_token jsonb NOT NULL,original_history jsonb,
 created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.membership_fee_requote ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.membership_fee_requote FROM PUBLIC,anon,authenticated;
GRANT SELECT ON public.membership_fee_requote TO service_role;
CREATE POLICY membership_fee_requote_service ON public.membership_fee_requote TO service_role USING(true);
CREATE FUNCTION public.membership_fee_regenerate_quote(p_tenant_id uuid,p_token_id uuid,p_expected_updated_at timestamptz,
 p_new_token text,p_final_cost numeric,p_breakdown jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE t public.membership_fee_token%ROWTYPE; replacement public.membership_fee_token%ROWTYPE;
 audit public.membership_fee_requote%ROWTYPE; h jsonb; tab text; gross numeric;
BEGIN
 SELECT * INTO t FROM public.membership_fee_token WHERE id=p_token_id AND tenant_id=p_tenant_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Original membership quote not found'; END IF;
 SELECT * INTO audit FROM public.membership_fee_requote WHERE predecessor_token_id=t.id;
 IF FOUND THEN SELECT * INTO replacement FROM public.membership_fee_token WHERE id=audit.replacement_token_id; RETURN to_jsonb(replacement); END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('membership-payment:'||p_tenant_id::text||':'||
  CASE WHEN t.member_id IS NULL THEN 'organization' ELSE 'member' END||':'||coalesce(t.member_id,t.organization_id)::text||':'||t.membership_year,0));
 IF t.status<>'pending' OR t.expires_at<=now() OR t.updated_at IS DISTINCT FROM p_expected_updated_at
  OR t.stripe_payment_intent_id IS NOT NULL OR to_jsonb(t)->>'stripe_payment_attempted_at' IS NOT NULL
  OR EXISTS(SELECT 1 FROM public.membership_voucher_settlement WHERE fee_token_id=t.id AND state<>'released')
  OR EXISTS(SELECT 1 FROM public.membership_payment_term_claim WHERE tenant_id=p_tenant_id
    AND owner_id=coalesce(t.member_id,t.organization_id) AND membership_year=t.membership_year)
  OR EXISTS(SELECT 1 FROM public.membership_billing_agreements a WHERE a.tenant_id=p_tenant_id
    AND coalesce(a.member_id,a.organization_id)=coalesce(t.member_id,t.organization_id)
    AND coalesce(a.metadata->'card'->>'membership_year',a.metadata->'dd'->>'membership_year')=t.membership_year
    AND a.status NOT IN ('cancelled','expired','failed','replaced','payment_plan_cancelled'))
 THEN RAISE EXCEPTION 'A payment has started or the original quote changed; reconcile it before replacement'; END IF;
 IF p_new_token !~ '^[a-f0-9]{64}$' OR p_final_cost<0 OR p_final_cost<>round(p_final_cost,2)
  OR p_breakdown->'membershipVoucherRequote'->>'predecessorTokenId' IS DISTINCT FROM t.id::text
 THEN RAISE EXCEPTION 'Invalid saved replacement quote'; END IF;
 gross:=(p_breakdown->>'totalWithVat')::numeric;
 IF gross IS NULL OR gross<0 OR gross<>round(gross,2) THEN RAISE EXCEPTION 'Invalid replacement gross'; END IF;
 IF t.history_record_id IS NOT NULL THEN
  tab:=CASE WHEN t.member_id IS NOT NULL THEN 'member_membership_history' ELSE 'organisation_membership_history' END;
  EXECUTE format('SELECT to_jsonb(h) FROM public.%I h WHERE id=$1 AND tenant_id=$2 FOR UPDATE',tab) INTO h USING t.history_record_id,p_tenant_id;
  IF h IS NULL OR h->>'payment_status' IN ('paid','partial','unverified','voided')
    OR nullif(h->>'billing_agreement_id','') IS NOT NULL OR nullif(h->>'stripe_payment_intent_id','') IS NOT NULL
  THEN RAISE EXCEPTION 'Original financial history cannot be replaced'; END IF;
 END IF;
 IF coalesce(h->>'accounting_invoice_id',h->>'xero_invoice_id',to_jsonb(t)->>'accounting_invoice_id',to_jsonb(t)->>'xero_invoice_id') IS NOT NULL
  AND (gross<>coalesce((h->>'total_with_vat')::numeric,(t.cost_breakdown->>'totalWithVat')::numeric,t.final_cost)
    OR p_final_cost<>coalesce((h->>'final_cost')::numeric,t.final_cost)) THEN
  RAISE EXCEPTION 'An issued invoice must retain its original gross and tax';
 END IF;
 replacement:=jsonb_populate_record(NULL::public.membership_fee_token,to_jsonb(t)||jsonb_build_object(
  'id',gen_random_uuid(),'token',p_new_token,'status','pending','final_cost',p_final_cost,
  'cost_breakdown',p_breakdown,'created_at',now(),'updated_at',now()));
 INSERT INTO public.membership_fee_token SELECT replacement.*;
 INSERT INTO public.membership_fee_requote(tenant_id,predecessor_token_id,replacement_token_id,original_token,original_history)
  VALUES(p_tenant_id,t.id,replacement.id,to_jsonb(t),h);
 IF h IS NOT NULL THEN
  EXECUTE format('UPDATE public.%I SET final_cost=$1,total_with_vat=$2,vat_amount=$3 WHERE id=$4 AND tenant_id=$5',tab)
   USING p_final_cost,gross,gross-p_final_cost,t.history_record_id,p_tenant_id;
 END IF;
 UPDATE public.membership_fee_token SET status='cancelled',updated_at=now() WHERE id=t.id;
 RETURN to_jsonb(replacement);
END $$;
REVOKE ALL ON FUNCTION public.membership_fee_regenerate_quote(uuid,uuid,timestamptz,text,numeric,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.membership_fee_regenerate_quote(uuid,uuid,timestamptz,text,numeric,jsonb) TO service_role;
