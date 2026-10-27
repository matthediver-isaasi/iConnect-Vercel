BEGIN;
-- Rebuild only the derived owner column; no backing claim or credit is removed.
ALTER TABLE public.member_credit_backing_claim
 ADD COLUMN cancellation_request_id uuid REFERENCES public.member_cancellation_request(id),
 DROP CONSTRAINT member_credit_backing_legacy_owner,
 DROP COLUMN legacy_amendment_id;
ALTER TABLE public.member_credit_backing_claim
 ADD COLUMN legacy_amendment_id uuid GENERATED ALWAYS AS
  (CASE WHEN replacement_execution_id IS NULL AND cancellation_request_id IS NULL THEN amendment_id ELSE NULL END) STORED,
 ADD CONSTRAINT member_credit_backing_legacy_owner FOREIGN KEY(legacy_amendment_id)
  REFERENCES public.member_membership_amendment(id),
 ADD CONSTRAINT member_credit_backing_cancellation_owner CHECK(cancellation_request_id IS NULL
  OR (cancellation_request_id=amendment_id AND replacement_execution_id IS NULL));

CREATE FUNCTION public.issue_member_cancellation_credit(
 p_tenant_id uuid,p_request_id uuid,p_actor_id uuid,p_evidence jsonb)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE r public.member_cancellation_request; f public.member_cancellation_finance;
 note public.member_cancellation_finance_step; payment public.member_cancellation_finance_step;
 b jsonb; context jsonb; issued jsonb; days integer; expires timestamptz;
BEGIN
 SELECT * INTO r FROM public.member_cancellation_request WHERE id=p_request_id AND tenant_id=p_tenant_id;
 SELECT * INTO f FROM public.member_cancellation_finance WHERE request_id=p_request_id AND tenant_id=p_tenant_id;
 IF r.id IS NULL OR f.request_id IS NULL OR p_actor_id IS NULL OR r.access_ended_at IS NULL
  OR f.plan->>'choice' IS DISTINCT FROM 'credit'
  OR NOT EXISTS(SELECT 1 FROM public.member_cancellation_finance_application WHERE request_id=r.id)
 THEN RAISE EXCEPTION 'Credit issuance must be atomic with owned cancellation settlement'; END IF;
 SELECT * INTO note FROM public.member_cancellation_finance_step WHERE request_id=r.id AND step_key='surplus_note';
 SELECT * INTO payment FROM public.member_cancellation_finance_step WHERE request_id=r.id AND step_key='backing';
 b:=payment.descriptor->'liabilityBinding';
 IF note.state IS DISTINCT FROM 'observed' OR payment.state IS DISTINCT FROM 'observed'
  OR b->>'kind' IS DISTINCT FROM 'iconnect_member_credit_liability'
  OR b->>'provider' IS DISTINCT FROM 'xero' OR b->>'accountId' IS NULL
  OR b->>'providerTenantId' IS DISTINCT FROM f.source_evidence->>'providerTenantId'
  OR b->>'currency' IS DISTINCT FROM f.plan->>'currency'
  OR payment.descriptor->>'reference' IS DISTINCT FROM note.descriptor->>'reference'
  OR payment.descriptor->'amount' IS DISTINCT FROM f.plan->'returnAmount'
  OR note.descriptor->'amount' IS DISTINCT FROM f.plan->'returnAmount'
  OR p_evidence->>'kind' IS DISTINCT FROM 'member_credit_backed'
  OR p_evidence->>'verified' IS DISTINCT FROM 'true'
  OR p_evidence->>'documentId' IS DISTINCT FROM note.evidence->>'id'
  OR p_evidence->>'paymentId' IS DISTINCT FROM payment.evidence->>'id'
  OR p_evidence->>'liabilityAccountId' IS DISTINCT FROM b->>'accountId'
  OR p_evidence->>'retainedCreditMinor' IS DISTINCT FROM '0'
  OR COALESCE((f.plan->>'surplusMinor')::bigint,0)<=0
  OR (f.plan->'returnAmount'->>'grossMinor')::bigint IS DISTINCT FROM (f.plan->>'surplusMinor')::bigint
  OR f.calculation->'finance'->>'personalFundingOnly' IS DISTINCT FROM 'true'
  OR COALESCE((f.calculation->'finance'->'settled'->>'grossMinor')::bigint,0)<(f.plan->>'surplusMinor')::bigint
  OR COALESCE(jsonb_array_length(f.calculation->'finance'->'voucherFunding'),0)<>0
  OR COALESCE(jsonb_array_length(f.calculation->'finance'->'organisationFunding'),0)<>0
 THEN RAISE EXCEPTION 'Exact observed cancellation liability backing required'; END IF;
 IF EXISTS(SELECT 1 FROM public.member_membership_credit WHERE amendment_id=r.id) THEN
  RAISE EXCEPTION 'Cancellation credit already exists outside this finalization';
 END IF;
 context:=note.descriptor||jsonb_build_object('xeroTenantId',b->>'providerTenantId',
  'amounts',f.plan->'returnAmount','memberCreditLiabilityBinding',b);
 INSERT INTO public.member_credit_backing_claim(amendment_id,tenant_id,member_id,actor_id,
  document_id,context,cancellation_request_id)
 VALUES(r.id,p_tenant_id,r.member_id,p_actor_id,note.evidence->>'id',context,r.id);
 days:=(r.authority->'policySnapshot'->'policy'->>'creditExpiryDays')::integer;
 IF days IS NOT NULL AND days NOT BETWEEN 1 AND 36500 THEN RAISE EXCEPTION 'Invalid cancellation credit expiry'; END IF;
 expires:=CASE WHEN days IS NULL THEN NULL ELSE now()+make_interval(days=>days) END;
 issued:=public.voucher_admin_write_before_member_credit(p_tenant_id,NULL,'issue',jsonb_build_object(
  'member_id',r.member_id,'code','MC-'||replace(r.id::text,'-',''),
  'value',(f.plan->>'surplusMinor')::numeric/100,'currency',f.plan->>'currency',
  'description','Membership cancellation credit','funding_source','membership_change','expires_at',expires),
  'membership-change:'||p_actor_id::text,'membership-change:'||r.id::text);
 INSERT INTO public.member_membership_credit(amendment_id,tenant_id,member_id,voucher_id,
  provider_payment_id,liability_binding,amount_minor)
 VALUES(r.id,p_tenant_id,r.member_id,(issued->>'id')::uuid,p_evidence->>'paymentId',b,(f.plan->>'surplusMinor')::bigint);
END $$;
REVOKE ALL ON FUNCTION public.issue_member_cancellation_credit(uuid,uuid,uuid,jsonb)
 FROM PUBLIC,anon,authenticated,service_role;

ALTER FUNCTION public.member_credit_funding_proofs(uuid,uuid[]) RENAME TO member_credit_funding_proofs_before_cancellation;
REVOKE ALL ON FUNCTION public.member_credit_funding_proofs_before_cancellation(uuid,uuid[])
 FROM PUBLIC,anon,authenticated,service_role;
CREATE FUNCTION public.member_credit_funding_proofs(p_tenant_id uuid,p_allocation_ids uuid[])
RETURNS SETOF jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
 RETURN QUERY SELECT * FROM public.member_credit_funding_proofs_before_cancellation(p_tenant_id,p_allocation_ids);
 RETURN QUERY SELECT jsonb_build_object(
  'allocationId',allocation.id,'binding',credit.liability_binding,
  'amendment',jsonb_build_object('id',r.id,'tenant_id',r.tenant_id,'member_id',r.member_id,
   'execution_kind','cancellation',
   'cancellationProof',jsonb_build_object('record',to_jsonb(r),'sourceEvidence',f.source_evidence,
    'steps',(SELECT jsonb_agg(to_jsonb(s) ORDER BY s.step_key)
     FROM public.member_cancellation_finance_step s WHERE s.request_id=r.id)),
   'quote',jsonb_build_object('sourceSnapshot',r.source_snapshot,'currency',f.plan->>'currency',
    'originalFullTerm',f.calculation->'finance'->'original','fundingEvidence',f.source_evidence->'providerEvidence')),
  'settlement',jsonb_build_object('amendment_id',r.id,'tenant_id',r.tenant_id,'state','applied',
   'choice','credit','context',claim.context,'evidence',applied.evidence))
 FROM public.voucher_credit_allocation allocation
 JOIN public.member_membership_credit credit ON credit.voucher_id=allocation.voucher_id AND credit.tenant_id=allocation.tenant_id
 JOIN public.member_credit_backing_claim claim ON claim.amendment_id=credit.amendment_id AND claim.tenant_id=credit.tenant_id
 JOIN public.member_cancellation_request r ON r.id=claim.cancellation_request_id AND r.tenant_id=credit.tenant_id
 JOIN public.member_cancellation_finance f ON f.request_id=r.id AND f.tenant_id=r.tenant_id
 JOIN public.member_cancellation_finance_application applied ON applied.request_id=r.id
 WHERE credit.tenant_id=p_tenant_id AND allocation.id=ANY(p_allocation_ids);
END $$;
REVOKE ALL ON FUNCTION public.member_credit_funding_proofs(uuid,uuid[]) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.member_credit_funding_proofs(uuid,uuid[]) TO service_role;
NOTIFY pgrst,'reload schema';
COMMIT;
