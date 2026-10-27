-- Fence external funding against a concurrent whole-purchase compensation.
BEGIN;
CREATE TABLE public.member_credit_funding_claim (
 tenant_id uuid NOT NULL,allocation_id uuid NOT NULL REFERENCES public.voucher_credit_allocation(id),
 reference text NOT NULL CHECK(length(reference) BETWEEN 1 AND 500),
 context jsonb NOT NULL CHECK(jsonb_typeof(context)='object'),
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,allocation_id,reference)
);
ALTER TABLE public.member_credit_funding_claim ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.member_credit_funding_claim FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.member_credit_funding_claim TO service_role;
CREATE TRIGGER immutable BEFORE UPDATE OR DELETE ON public.member_credit_funding_claim
 FOR EACH ROW EXECUTE FUNCTION public.reject_member_change_authority_mutation();

CREATE FUNCTION public.claim_member_credit_funding(p_tenant_id uuid,p_allocation_id uuid,p_context jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE a public.voucher_credit_allocation; p public.voucher_credit_purchase;
 c public.member_membership_credit; prior public.member_credit_funding_claim; total bigint; n bigint;
BEGIN
 SELECT * INTO a FROM public.voucher_credit_allocation WHERE tenant_id=p_tenant_id AND id=p_allocation_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'Funding allocation not found'; END IF;
 SELECT * INTO p FROM public.voucher_credit_purchase WHERE tenant_id=p_tenant_id AND id=a.purchase_id;
 PERFORM pg_advisory_xact_lock(hashtextextended(p_tenant_id::text||':'||p.purchase_key,0));
 SELECT * INTO p FROM public.voucher_credit_purchase WHERE tenant_id=p_tenant_id AND id=a.purchase_id FOR UPDATE;
 IF p.state IS DISTINCT FROM 'committed' THEN RAISE EXCEPTION 'Funding purchase is not committed'; END IF;
 PERFORM 1 FROM public.voucher_credit_allocation WHERE id=a.id AND tenant_id=p_tenant_id FOR UPDATE;
 SELECT * INTO c FROM public.member_membership_credit WHERE tenant_id=p_tenant_id AND voucher_id=a.voucher_id;
 n:=(p_context->>'amountMinor')::bigint;
 IF c.amendment_id IS NULL OR n IS NULL OR n<=0
  OR p_context->>'providerTenantId' IS DISTINCT FROM c.liability_binding->>'providerTenantId'
  OR p_context->>'accountId' IS DISTINCT FROM c.liability_binding->>'accountId'
  OR p_context->>'provider' IS DISTINCT FROM 'xero'
  OR coalesce(length(p_context->>'invoiceId'),0)=0 THEN RAISE EXCEPTION 'Original liability funding context required'; END IF;
 SELECT * INTO prior FROM public.member_credit_funding_claim WHERE tenant_id=p_tenant_id
  AND allocation_id=a.id AND reference=p_context->>'reference';
 IF FOUND THEN
  IF prior.context IS DISTINCT FROM p_context THEN RAISE EXCEPTION 'Immutable funding claim differs'; END IF;
  RETURN jsonb_build_object('context',prior.context,'existing',true);
 END IF;
 SELECT coalesce(sum((context->>'amountMinor')::bigint),0) INTO total FROM public.member_credit_funding_claim
  WHERE tenant_id=p_tenant_id AND allocation_id=a.id;
 IF total+n>a.amount_minor THEN RAISE EXCEPTION 'Funding claims exceed original allocation'; END IF;
 INSERT INTO public.member_credit_funding_claim(tenant_id,allocation_id,reference,context)
  VALUES(p_tenant_id,a.id,p_context->>'reference',p_context);
 RETURN jsonb_build_object('context',p_context,'existing',false);
END $$;
REVOKE ALL ON FUNCTION public.claim_member_credit_funding(uuid,uuid,jsonb) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.claim_member_credit_funding(uuid,uuid,jsonb) TO service_role;

-- Captured receipts must correspond to a pre-existing frozen write context.
DO $$
DECLARE body text; needle text:='n:=(p_evidence->>''amountMinor'')::bigint;';
BEGIN
 body:=pg_get_functiondef('public.record_member_credit_redemption(uuid,uuid,jsonb)'::regprocedure);
 IF position(needle IN body)=0 THEN RAISE EXCEPTION 'Unexpected redemption evidence contract'; END IF;
 body:=replace(body,needle,$patch$
 IF NOT EXISTS(SELECT 1 FROM public.member_credit_funding_claim f WHERE f.tenant_id=p_tenant_id
  AND f.allocation_id=p_allocation_id AND f.reference=p_evidence->>'reference'
  AND f.context=p_evidence-'paymentId') THEN RAISE EXCEPTION 'Frozen funding claim required'; END IF;
 n:=(p_evidence->>'amountMinor')::bigint;
 $patch$);
 EXECUTE body;
END $$;

ALTER FUNCTION public.voucher_credit_transition(uuid,text,text,text) RENAME TO voucher_credit_transition_before_member_credit;
REVOKE ALL ON FUNCTION public.voucher_credit_transition_before_member_credit(uuid,text,text,text)
 FROM PUBLIC,anon,authenticated,service_role;
CREATE FUNCTION public.voucher_credit_transition(p_tenant_id uuid,p_purchase_key text,p_action text,p_provider_outcome text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE p public.voucher_credit_purchase;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended(p_tenant_id::text||':'||p_purchase_key,0));
 SELECT * INTO p FROM public.voucher_credit_purchase WHERE tenant_id=p_tenant_id AND purchase_key=p_purchase_key FOR UPDATE;
 IF p_action='release' AND p.state='committed' AND EXISTS(
  SELECT 1 FROM public.voucher_credit_allocation a JOIN public.member_membership_credit c
   ON c.tenant_id=a.tenant_id AND c.voucher_id=a.voucher_id
  WHERE a.tenant_id=p_tenant_id AND a.purchase_id=p.id
   AND EXISTS(SELECT 1 FROM public.member_credit_funding_claim f WHERE f.tenant_id=a.tenant_id AND f.allocation_id=a.id)
   AND a.amount_minor>coalesce((SELECT sum(r.cumulative_minor) FROM public.voucher_allocation_refund r
    WHERE r.tenant_id=a.tenant_id AND r.allocation_id=a.id),0)
 ) THEN RAISE EXCEPTION 'Reconcile claimed liability funding before releasing member credit'; END IF;
 RETURN public.voucher_credit_transition_before_member_credit(p_tenant_id,p_purchase_key,p_action,p_provider_outcome);
END $$;
REVOKE ALL ON FUNCTION public.voucher_credit_transition(uuid,text,text,text) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.voucher_credit_transition(uuid,text,text,text) TO service_role;
COMMIT;
