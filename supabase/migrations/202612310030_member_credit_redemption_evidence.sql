-- Immutable evidence of the original liability debits. Does not enable credit.
BEGIN;
CREATE TABLE public.member_credit_redemption (
 tenant_id uuid NOT NULL,
 allocation_id uuid NOT NULL REFERENCES public.voucher_credit_allocation(id),
 reference text NOT NULL CHECK(length(reference) BETWEEN 1 AND 500),
 invoice_id text NOT NULL CHECK(length(invoice_id)>0),
 payment_id text NOT NULL CHECK(length(payment_id)>0),
 amount_minor bigint NOT NULL CHECK(amount_minor>0),
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,allocation_id,reference),
 UNIQUE(tenant_id,payment_id)
);
ALTER TABLE public.member_credit_redemption ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.member_credit_redemption FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.member_credit_redemption TO service_role;
CREATE TRIGGER immutable BEFORE UPDATE OR DELETE ON public.member_credit_redemption
 FOR EACH ROW EXECUTE FUNCTION public.reject_member_change_authority_mutation();

CREATE FUNCTION public.record_member_credit_redemption(p_tenant_id uuid,p_allocation_id uuid,p_evidence jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE a public.voucher_credit_allocation; c public.member_membership_credit;
 prior public.member_credit_redemption; n bigint; total bigint;
BEGIN
 SELECT * INTO a FROM public.voucher_credit_allocation WHERE id=p_allocation_id AND tenant_id=p_tenant_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Funding allocation not found'; END IF;
 SELECT * INTO c FROM public.member_membership_credit WHERE tenant_id=p_tenant_id AND voucher_id=a.voucher_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'Backed member credit required'; END IF;
 n:=(p_evidence->>'amountMinor')::bigint;
 IF n IS NULL OR n<=0 OR p_evidence->>'providerTenantId' IS DISTINCT FROM c.liability_binding->>'providerTenantId'
  OR p_evidence->>'accountId' IS DISTINCT FROM c.liability_binding->>'accountId'
  OR p_evidence->>'provider' IS DISTINCT FROM 'xero' THEN RAISE EXCEPTION 'Original liability evidence required'; END IF;
 SELECT * INTO prior FROM public.member_credit_redemption WHERE tenant_id=p_tenant_id
  AND allocation_id=a.id AND reference=p_evidence->>'reference';
 IF FOUND THEN
  IF prior.invoice_id IS DISTINCT FROM p_evidence->>'invoiceId'
   OR prior.payment_id IS DISTINCT FROM p_evidence->>'paymentId' OR prior.amount_minor<>n
   THEN RAISE EXCEPTION 'Immutable funding evidence differs'; END IF;
  RETURN to_jsonb(prior);
 END IF;
 SELECT coalesce(sum(amount_minor),0) INTO total FROM public.member_credit_redemption
  WHERE tenant_id=p_tenant_id AND allocation_id=a.id;
 IF total+n>a.amount_minor THEN RAISE EXCEPTION 'Funding exceeds original allocation'; END IF;
 INSERT INTO public.member_credit_redemption(tenant_id,allocation_id,reference,invoice_id,payment_id,amount_minor)
  VALUES(p_tenant_id,a.id,p_evidence->>'reference',p_evidence->>'invoiceId',p_evidence->>'paymentId',n)
  RETURNING * INTO prior;
 RETURN to_jsonb(prior);
END $$;
REVOKE ALL ON FUNCTION public.record_member_credit_redemption(uuid,uuid,jsonb) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.record_member_credit_redemption(uuid,uuid,jsonb) TO service_role;

CREATE OR REPLACE FUNCTION public.member_credit_funding_proofs(p_tenant_id uuid,p_allocation_ids uuid[])
RETURNS SETOF jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT jsonb_build_object('allocationId',allocation.id,'amendment',to_jsonb(a),
  'settlement',to_jsonb(s),'binding',c.liability_binding)
 FROM public.voucher_credit_allocation allocation JOIN public.member_membership_credit c
  ON c.voucher_id=allocation.voucher_id AND c.tenant_id=allocation.tenant_id
 JOIN public.member_membership_amendment a ON a.id=c.amendment_id AND a.tenant_id=c.tenant_id
 JOIN public.member_membership_amendment_settlement s ON s.amendment_id=a.id AND s.tenant_id=a.tenant_id
 WHERE c.tenant_id=p_tenant_id AND allocation.id=ANY(p_allocation_ids)
$$;
COMMIT;
