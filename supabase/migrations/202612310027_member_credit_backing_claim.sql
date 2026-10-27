-- Protected second-stage accounting write claim. No financial writes/backfill.
-- This alone does NOT enable personal-credit execution or voucher issuance.
BEGIN;
CREATE TABLE public.member_credit_backing_claim (
 amendment_id uuid PRIMARY KEY REFERENCES public.member_membership_amendment(id),
 tenant_id uuid NOT NULL REFERENCES public.tenant(id),
 member_id uuid NOT NULL REFERENCES public.member(id),
 actor_id uuid NOT NULL,
 document_id text NOT NULL CHECK(length(document_id)>0),
 context jsonb NOT NULL CHECK(jsonb_typeof(context)='object'),
 created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.member_credit_backing_claim ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.member_credit_backing_claim FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.member_credit_backing_claim TO service_role;
CREATE TRIGGER immutable BEFORE UPDATE OR DELETE ON public.member_credit_backing_claim
 FOR EACH ROW EXECUTE FUNCTION public.reject_member_change_authority_mutation();

CREATE FUNCTION public.claim_member_credit_backing(
 p_tenant_id uuid,p_amendment_id uuid,p_actor_id uuid,p_document_id text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE a public.member_membership_amendment; s public.member_membership_amendment_settlement;
 prior public.member_credit_backing_claim; b jsonb;
BEGIN
 IF p_actor_id IS NULL OR COALESCE(length(p_document_id),0)=0 THEN
   RAISE EXCEPTION 'Audited credit backing context required' USING ERRCODE='22023';
 END IF;
 SELECT * INTO a FROM public.member_membership_amendment WHERE tenant_id=p_tenant_id AND id=p_amendment_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'Amendment not found' USING ERRCODE='40001'; END IF;
 PERFORM 1 FROM public.member WHERE id=a.member_id AND tenant_id=p_tenant_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Member not found' USING ERRCODE='40001'; END IF;
 SELECT * INTO s FROM public.member_membership_amendment_settlement
   WHERE tenant_id=p_tenant_id AND amendment_id=a.id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Settlement not found' USING ERRCODE='40001'; END IF;
 b:=s.context->'memberCreditLiabilityBinding';
 IF s.choice IS DISTINCT FROM 'credit' OR s.member_id IS DISTINCT FROM a.member_id
   OR b IS NULL OR b IS DISTINCT FROM a.quote->'memberCreditLiabilityBinding'
   OR b->>'provider' IS DISTINCT FROM 'xero'
   OR b->>'kind' IS DISTINCT FROM 'iconnect_member_credit_liability'
   OR b->>'providerTenantId' IS DISTINCT FROM s.context->>'xeroTenantId'
   OR b->>'currency' IS DISTINCT FROM s.context->>'currency'
   OR COALESCE(length(b->>'accountId'),0)=0
   OR NOT COALESCE((s.context->'amounts'->>'grossMinor')::bigint>0,false)
   OR (s.context->'amounts'->>'grossMinor')::bigint IS DISTINCT FROM
     -(a.quote->'delta'->>'grossMinor')::bigint THEN
   RAISE EXCEPTION 'Verified personal-credit settlement required' USING ERRCODE='40001';
 END IF;
 SELECT * INTO prior FROM public.member_credit_backing_claim WHERE amendment_id=a.id;
 IF FOUND THEN
   IF prior.tenant_id IS DISTINCT FROM p_tenant_id OR prior.document_id IS DISTINCT FROM p_document_id
     OR prior.context IS DISTINCT FROM s.context THEN
     RAISE EXCEPTION 'Credit backing claim changed' USING ERRCODE='40001';
   END IF;
   RETURN jsonb_build_object('claimed',false);
 END IF;
 IF s.state IS DISTINCT FROM 'awaiting_payment'
   OR s.evidence->>'kind' IS DISTINCT FROM 'awaiting_member_credit_backing'
   OR s.evidence->>'verified' IS DISTINCT FROM 'true'
   OR s.evidence->>'documentId' IS DISTINCT FROM p_document_id THEN
   RAISE EXCEPTION 'Credit note not verified for backing' USING ERRCODE='40001';
 END IF;
 INSERT INTO public.member_credit_backing_claim(amendment_id,tenant_id,member_id,actor_id,document_id,context)
 VALUES(a.id,p_tenant_id,a.member_id,p_actor_id,p_document_id,s.context);
 RETURN jsonb_build_object('claimed',true,'context',s.context,'documentId',p_document_id);
END $$;
REVOKE ALL ON FUNCTION public.claim_member_credit_backing(uuid,uuid,uuid,text)
 FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.claim_member_credit_backing(uuid,uuid,uuid,text) TO service_role;
COMMIT;
