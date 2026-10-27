-- Accounting-verified partial returns. Execution remains disabled until the
-- entire collection/compensation lifecycle is connected.
BEGIN;
CREATE FUNCTION public.member_credit_return_context(p_tenant_id uuid,p_allocation_id uuid,
 p_refund_key text,p_cumulative_minor bigint)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE proof jsonb; prior public.voucher_allocation_refund; entries jsonb;
 total bigint; returned bigint; expected bigint;
BEGIN
 SELECT v INTO proof FROM public.member_credit_funding_proofs(p_tenant_id,ARRAY[p_allocation_id]) v;
 IF proof IS NULL THEN RETURN jsonb_build_object('applicable',false); END IF;
 IF p_cumulative_minor IS NULL OR p_cumulative_minor<0 OR p_refund_key IS NULL
  OR length(p_refund_key) NOT BETWEEN 1 AND 250 THEN RAISE EXCEPTION 'Invalid credit return'; END IF;
 SELECT * INTO prior FROM public.voucher_allocation_refund WHERE tenant_id=p_tenant_id
  AND allocation_id=p_allocation_id AND refund_key=p_refund_key;
 IF FOUND AND prior.cumulative_minor=p_cumulative_minor THEN
  RETURN jsonb_build_object('applicable',true,'alreadyApplied',true,'result',prior.result);
 END IF;
 IF p_cumulative_minor<coalesce(prior.cumulative_minor,0) THEN RAISE EXCEPTION 'Credit return evidence decreased'; END IF;
 SELECT sum(amount_minor),jsonb_agg(jsonb_build_object('reference',reference,'invoiceId',invoice_id,
  'paymentId',payment_id,'amountMinor',amount_minor) ORDER BY reference) INTO total,entries
  FROM public.member_credit_redemption WHERE tenant_id=p_tenant_id AND allocation_id=p_allocation_id;
 IF total IS NULL THEN RAISE EXCEPTION 'Complete original funding accounting before returning member credit'; END IF;
 SELECT coalesce(sum(cumulative_minor),0) INTO returned FROM public.voucher_allocation_refund
  WHERE tenant_id=p_tenant_id AND allocation_id=p_allocation_id AND refund_key<>p_refund_key;
 expected:=total-returned-p_cumulative_minor;
 IF expected<0 THEN RAISE EXCEPTION 'Credit return exceeds recorded funding payments'; END IF;
 RETURN proof||jsonb_build_object('applicable',true,'entries',entries,'expectedActiveMinor',expected);
END $$;
REVOKE ALL ON FUNCTION public.member_credit_return_context(uuid,uuid,text,bigint) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.member_credit_return_context(uuid,uuid,text,bigint) TO service_role;

ALTER FUNCTION public.voucher_credit_refund_allocation(uuid,uuid,text,bigint,jsonb)
 RENAME TO voucher_credit_refund_before_member_credit;
REVOKE ALL ON FUNCTION public.voucher_credit_refund_before_member_credit(uuid,uuid,text,bigint,jsonb)
 FROM PUBLIC,anon,authenticated,service_role;
-- Returned generated credit retains its original owner and expiry, including
-- an expired balance for manual liability review. Never create an untracked
-- replacement voucher with no link to the liability backing.
DO $$
DECLARE body text;
BEGIN
 body:=pg_get_functiondef('public.voucher_credit_refund_before_member_credit(uuid,uuid,text,bigint,jsonb)'::regprocedure);
 IF position('IF v.expires_at<=now() THEN' IN body)=0
  OR position('SET value=value+amount/100.0,status=''active'',used_at=NULL' IN body)=0
  THEN RAISE EXCEPTION 'Unexpected voucher-return contract'; END IF;
 body:=replace(body,'IF v.expires_at<=now() THEN',
  'IF v.expires_at<=now() AND NOT EXISTS(SELECT 1 FROM public.member_membership_credit c WHERE c.tenant_id=p_tenant_id AND c.voucher_id=v.id) THEN');
 body:=replace(body,'SET value=value+amount/100.0,status=''active'',used_at=NULL',
  'SET value=value+amount/100.0,status=CASE WHEN expires_at<=now() THEN ''expired'' ELSE ''active'' END,used_at=NULL');
 EXECUTE body;
END $$;
CREATE FUNCTION public.voucher_credit_refund_allocation(p_tenant_id uuid,p_allocation_id uuid,p_refund_key text,
 p_cumulative_minor bigint,p_reversal_options jsonb DEFAULT '{}')
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM public.voucher_credit_allocation a JOIN public.member_membership_credit c
  ON c.tenant_id=a.tenant_id AND c.voucher_id=a.voucher_id WHERE a.tenant_id=p_tenant_id AND a.id=p_allocation_id)
  THEN RAISE EXCEPTION 'Accounting-verified member credit return required'; END IF;
 RETURN public.voucher_credit_refund_before_member_credit(p_tenant_id,p_allocation_id,p_refund_key,p_cumulative_minor,p_reversal_options);
END $$;
REVOKE ALL ON FUNCTION public.voucher_credit_refund_allocation(uuid,uuid,text,bigint,jsonb) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.voucher_credit_refund_allocation(uuid,uuid,text,bigint,jsonb) TO service_role;

CREATE FUNCTION public.apply_verified_member_credit_return(p_tenant_id uuid,p_allocation_id uuid,
 p_refund_key text,p_cumulative_minor bigint,p_verified_active_minor bigint,p_reversal_options jsonb DEFAULT '{}')
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE purchase public.voucher_credit_purchase; context jsonb;
BEGIN
 SELECT p.* INTO purchase FROM public.voucher_credit_purchase p JOIN public.voucher_credit_allocation a
  ON a.purchase_id=p.id AND a.tenant_id=p.tenant_id WHERE a.id=p_allocation_id AND a.tenant_id=p_tenant_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'Funding purchase not found'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(p_tenant_id::text||':'||purchase.purchase_key,0));
 PERFORM 1 FROM public.voucher_credit_purchase WHERE id=purchase.id AND tenant_id=p_tenant_id FOR UPDATE;
 -- Same allocation lock as receipt insertion: reject stale verified totals if
 -- another receipt or return arrived while the provider was being read.
 PERFORM 1 FROM public.voucher_credit_allocation WHERE id=p_allocation_id AND tenant_id=p_tenant_id FOR UPDATE;
 context:=public.member_credit_return_context(p_tenant_id,p_allocation_id,p_refund_key,p_cumulative_minor);
 IF context->>'applicable' IS DISTINCT FROM 'true' THEN RAISE EXCEPTION 'Backed member credit required'; END IF;
 IF context->>'alreadyApplied'='true' THEN RETURN context->'result'; END IF;
 IF p_verified_active_minor IS NULL OR p_verified_active_minor<0
  OR (context->>'expectedActiveMinor')::bigint<>p_verified_active_minor THEN
  RAISE EXCEPTION 'Credit accounting evidence changed; reverify before return' USING ERRCODE='40001';
 END IF;
 RETURN public.voucher_credit_refund_before_member_credit(p_tenant_id,p_allocation_id,p_refund_key,p_cumulative_minor,p_reversal_options);
END $$;
REVOKE ALL ON FUNCTION public.apply_verified_member_credit_return(uuid,uuid,text,bigint,bigint,jsonb)
 FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.apply_verified_member_credit_return(uuid,uuid,text,bigint,bigint,jsonb) TO service_role;
COMMIT;
