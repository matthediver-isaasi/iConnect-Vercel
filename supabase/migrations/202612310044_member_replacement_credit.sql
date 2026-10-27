-- Extend the existing liability-backed credit lifecycle to replacement terms.
-- Original amendment-backed credits keep their original FK and verifier.
BEGIN;
ALTER TABLE public.member_credit_backing_claim
 ADD COLUMN replacement_execution_id uuid REFERENCES public.member_replacement_execution(id),
 ADD COLUMN legacy_amendment_id uuid GENERATED ALWAYS AS
  (CASE WHEN replacement_execution_id IS NULL THEN amendment_id ELSE NULL END) STORED;
ALTER TABLE public.member_credit_backing_claim
 ADD CONSTRAINT member_credit_backing_legacy_owner FOREIGN KEY(legacy_amendment_id)
  REFERENCES public.member_membership_amendment(id),
 ADD CONSTRAINT member_credit_backing_replacement_owner
  CHECK(replacement_execution_id IS NULL OR replacement_execution_id=amendment_id);
ALTER TABLE public.member_credit_backing_claim DROP CONSTRAINT member_credit_backing_claim_amendment_id_fkey;

CREATE FUNCTION public.issue_member_replacement_credit(p_tenant_id uuid,p_execution_id uuid,p_actor_id uuid,p_evidence jsonb)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE e public.member_replacement_execution; a public.member_change_authority; b jsonb; proof jsonb;
 note public.member_replacement_step; payment public.member_replacement_step;
 context jsonb; issued jsonb; days integer; expires timestamptz;
BEGIN
 SELECT * INTO e FROM public.member_replacement_execution WHERE tenant_id=p_tenant_id AND id=p_execution_id;
 IF NOT FOUND OR p_actor_id IS NULL THEN RAISE EXCEPTION 'Execution and audit actor required'; END IF;
 IF e.plan->>'choice'<>'credit' THEN RETURN; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.member_replacement_application WHERE execution_id=e.id AND tenant_id=p_tenant_id)
 THEN RAISE EXCEPTION 'Credit issuance must be atomic with membership application'; END IF;
 SELECT * INTO a FROM public.member_change_authority WHERE id=e.authority_id AND tenant_id=p_tenant_id;
 SELECT * INTO note FROM public.member_replacement_step WHERE execution_id=e.id AND step_key='surplus_note';
 SELECT * INTO payment FROM public.member_replacement_step WHERE execution_id=e.id AND step_key='credit_backing';
 b:=e.plan->'liabilityBinding'; proof:=p_evidence->'surplusEvidence';
 IF b IS DISTINCT FROM a.authority->'creditLiabilityBinding' OR b->>'accountId' IS NULL
  OR note.state IS DISTINCT FROM 'observed' OR payment.state IS DISTINCT FROM 'observed'
  OR proof->>'kind' IS DISTINCT FROM 'member_credit_backed'
  OR proof->>'verified' IS DISTINCT FROM 'true'
  OR proof->>'documentId' IS DISTINCT FROM note.evidence->>'id'
  OR proof->>'paymentId' IS DISTINCT FROM payment.evidence->>'id'
  OR proof->>'liabilityAccountId' IS DISTINCT FROM b->>'accountId'
  OR proof->>'retainedCreditMinor' IS DISTINCT FROM '0'
  OR (e.plan->'surplus'->>'grossMinor')::bigint<=0
 THEN RAISE EXCEPTION 'Verified replacement liability backing required'; END IF;
 context:=note.descriptor||jsonb_build_object('xeroTenantId',b->>'providerTenantId',
  'amounts',e.plan->'surplus','memberCreditLiabilityBinding',b);
 INSERT INTO public.member_credit_backing_claim(amendment_id,tenant_id,member_id,actor_id,
  document_id,context,replacement_execution_id)
 VALUES(e.id,p_tenant_id,e.member_id,p_actor_id,note.evidence->>'id',context,e.id);
 days:=(a.authority->'policySnapshot'->'policy'->>'creditExpiryDays')::integer;
 IF days IS NOT NULL AND days NOT BETWEEN 1 AND 36500 THEN RAISE EXCEPTION 'Invalid credit expiry'; END IF;
 expires:=CASE WHEN days IS NULL THEN NULL ELSE now()+make_interval(days=>days) END;
 issued:=public.voucher_admin_write_before_member_credit(p_tenant_id,NULL,'issue',jsonb_build_object(
  'member_id',e.member_id,'code','MC-'||replace(e.id::text,'-',''),
  'value',(e.plan->'surplus'->>'grossMinor')::numeric/100,'currency',e.plan->>'currency',
  'description','Membership replacement credit','funding_source','membership_change','expires_at',expires),
  'membership-change:'||p_actor_id::text,'membership-change:'||e.id::text);
 INSERT INTO public.member_membership_credit(amendment_id,tenant_id,member_id,voucher_id,
  provider_payment_id,liability_binding,amount_minor)
 VALUES(e.id,p_tenant_id,e.member_id,(issued->>'id')::uuid,proof->>'paymentId',b,
  (e.plan->'surplus'->>'grossMinor')::bigint);
END $$;
REVOKE ALL ON FUNCTION public.issue_member_replacement_credit(uuid,uuid,uuid,jsonb) FROM PUBLIC,anon,authenticated,service_role;
DO $$
DECLARE body text; guard text:=$g$IF e.plan->>'choice'='credit' THEN RAISE EXCEPTION 'Replacement credit issuance is not enabled'; END IF;$g$;
 needle text:='SET CONSTRAINTS member_replacement_application_target_record_id_fkey IMMEDIATE;';
BEGIN
 body:=pg_get_functiondef('public.apply_member_replacement(uuid,uuid,uuid,jsonb,jsonb)'::regprocedure);
 IF position(guard IN body)=0 OR position(needle IN body)=0 THEN RAISE EXCEPTION 'Replacement application contract needs review'; END IF;
 body:=replace(body,guard,'');
 body:=replace(body,needle,'PERFORM public.issue_member_replacement_credit(p_tenant_id,e.id,p_actor_id,p_evidence);'||chr(10)||needle);
 EXECUTE body;
END $$;

ALTER FUNCTION public.member_credit_funding_proofs(uuid,uuid[]) RENAME TO member_credit_funding_proofs_before_replacement;
REVOKE ALL ON FUNCTION public.member_credit_funding_proofs_before_replacement(uuid,uuid[]) FROM PUBLIC,anon,authenticated,service_role;
CREATE FUNCTION public.member_credit_funding_proofs(p_tenant_id uuid,p_allocation_ids uuid[])
RETURNS SETOF jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
 -- Retain orphan-provenance checks and all existing amendment proof behavior.
 RETURN QUERY SELECT * FROM public.member_credit_funding_proofs_before_replacement(p_tenant_id,p_allocation_ids);
 RETURN QUERY
 SELECT jsonb_build_object('allocationId',allocation.id,'binding',credit.liability_binding,
  'amendment',jsonb_build_object('id',e.id,'tenant_id',e.tenant_id,'member_id',e.member_id,
   'execution_kind','replacement','quote',jsonb_build_object(
    'sourceSnapshot',a.authority->'sourceSnapshot','currency',e.plan->>'currency',
    'originalFullTerm',a.authority->'calculation'->'finance'->'original',
    'fundingEvidence',a.authority->'fundingEvidence'->'providerEvidence')),
  'settlement',jsonb_build_object('amendment_id',e.id,'tenant_id',e.tenant_id,'state','applied',
   'choice','credit','context',claim.context,'evidence',applied.evidence->'surplusEvidence'))
 FROM public.voucher_credit_allocation allocation
 JOIN public.member_membership_credit credit ON credit.voucher_id=allocation.voucher_id AND credit.tenant_id=allocation.tenant_id
 JOIN public.member_credit_backing_claim claim ON claim.amendment_id=credit.amendment_id AND claim.tenant_id=credit.tenant_id
 JOIN public.member_replacement_execution e ON e.id=claim.replacement_execution_id AND e.tenant_id=credit.tenant_id
 JOIN public.member_replacement_application applied ON applied.execution_id=e.id AND applied.tenant_id=e.tenant_id
 JOIN public.member_change_authority a ON a.id=e.authority_id AND a.tenant_id=e.tenant_id
 WHERE credit.tenant_id=p_tenant_id AND allocation.id=ANY(p_allocation_ids);
END $$;
REVOKE ALL ON FUNCTION public.member_credit_funding_proofs(uuid,uuid[]) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.member_credit_funding_proofs(uuid,uuid[]) TO service_role;
NOTIFY pgrst,'reload schema';
COMMIT;
