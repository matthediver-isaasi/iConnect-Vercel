-- Shared owner-preserving allocation reversal for approved non-booking refunds.
-- No new eligibility/refund policy: callers supply confirmed existing refund
-- authority. Expired-credit replacements require the same explicit future
-- expiry choice as voucher_credit_refund_booking.
CREATE TABLE public.voucher_allocation_refund (
 tenant_id uuid NOT NULL,allocation_id uuid NOT NULL REFERENCES public.voucher_credit_allocation(id),
 refund_key text NOT NULL,cumulative_minor bigint NOT NULL CHECK(cumulative_minor>=0),
 result jsonb NOT NULL,updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,allocation_id,refund_key)
);
ALTER TABLE public.voucher_allocation_refund ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.voucher_allocation_refund FROM PUBLIC,anon,authenticated;
GRANT SELECT ON public.voucher_allocation_refund TO service_role;
CREATE POLICY voucher_allocation_refund_service ON public.voucher_allocation_refund TO service_role USING(true);
CREATE FUNCTION public.voucher_credit_refund_allocation(p_tenant_id uuid,p_allocation_id uuid,p_refund_key text,
 p_cumulative_minor bigint,p_reversal_options jsonb DEFAULT '{}')
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE a public.voucher_credit_allocation%ROWTYPE; p public.voucher_credit_purchase%ROWTYPE;
 v public.voucher%ROWTYPE; replacement public.voucher%ROWTYPE; prior public.voucher_allocation_refund%ROWTYPE;
 amount bigint; available bigint; new_expiry timestamptz; result jsonb;
 previous_write text:=current_setting('app.voucher_credit_write',true);
 previous_reversal text:=current_setting('app.voucher_credit_reversal',true);
BEGIN
 SELECT * INTO a FROM public.voucher_credit_allocation WHERE id=p_allocation_id AND tenant_id=p_tenant_id;
 IF NOT FOUND OR p_cumulative_minor IS NULL OR p_cumulative_minor<0 OR p_refund_key IS NULL OR length(p_refund_key) NOT BETWEEN 1 AND 250 THEN
  RAISE EXCEPTION 'Invalid original credit refund allocation';
 END IF;
 -- Serialize with booking refunds and full-purchase compensation before
 -- evaluating remaining funding. All shared consumers take this lock first.
 SELECT * INTO p FROM public.voucher_credit_purchase WHERE id=a.purchase_id AND tenant_id=p_tenant_id;
 PERFORM pg_advisory_xact_lock(hashtextextended(p_tenant_id::text||':'||p.purchase_key,0));
 SELECT * INTO p FROM public.voucher_credit_purchase WHERE id=a.purchase_id AND tenant_id=p_tenant_id FOR UPDATE;
 IF p.state<>'committed' THEN RAISE EXCEPTION 'Only committed original credit can be refunded'; END IF;
 SELECT * INTO prior FROM public.voucher_allocation_refund WHERE tenant_id=p_tenant_id AND allocation_id=a.id AND refund_key=p_refund_key FOR UPDATE;
 IF FOUND AND p_cumulative_minor=prior.cumulative_minor THEN RETURN prior.result; END IF;
 IF p_cumulative_minor<coalesce(prior.cumulative_minor,0) THEN RAISE EXCEPTION 'Confirmed refund evidence decreased; financial reconciliation required'; END IF;
 amount:=p_cumulative_minor-coalesce(prior.cumulative_minor,0);
 SELECT a.amount_minor-coalesce(round(sum(t.amount)*100)::bigint,0) INTO available FROM public.voucher_transaction t
  WHERE t.tenant_id=p_tenant_id AND t.allocation_id=a.id AND t.type='cancellation_refund';
 IF amount>available THEN RAISE EXCEPTION 'Refund exceeds remaining original voucher funding'; END IF;
 SELECT * INTO STRICT v FROM public.voucher WHERE id=a.voucher_id AND tenant_id=p_tenant_id FOR UPDATE;
 IF v.organization_id IS DISTINCT FROM a.organization_id OR v.member_id IS DISTINCT FROM a.owner_member_id THEN
  RAISE EXCEPTION 'Original voucher owner changed';
 END IF;
 IF amount=0 THEN RETURN jsonb_build_object('voucherId',v.id,'amountMinor',0,'cumulativeMinor',p_cumulative_minor); END IF;
 PERFORM set_config('app.voucher_credit_write','yes',true);
 IF v.expires_at<=now() THEN
  SELECT (r->>'newExpiryDate')::timestamptz INTO new_expiry FROM jsonb_array_elements(coalesce(p_reversal_options->'voucherReplacements','[]')) r
   WHERE r->>'voucherId'=v.id::text LIMIT 1;
  IF new_expiry IS NULL OR new_expiry<=now() THEN RAISE EXCEPTION 'Expired voucher refund requires an approved future replacement expiry'; END IF;
  PERFORM set_config('app.voucher_credit_reversal','yes',true);
  INSERT INTO public.voucher(tenant_id,organization_id,member_id,code,value,description,expires_at,status,currency)
   VALUES(p_tenant_id,v.organization_id,v.member_id,'REFUND-'||v.code||'-'||gen_random_uuid()::text,
    amount/100.0,'Replacement for expired voucher '||v.code||' ('||p_refund_key||')',new_expiry,'active',v.currency)
   RETURNING * INTO replacement;
  INSERT INTO public.voucher_transaction(voucher_id,tenant_id,organization_id,owner_member_id,owner_display_name,
   booking_reference,amount,balance_before,balance_after,type,notes)
   VALUES(replacement.id,p_tenant_id,v.organization_id,v.member_id,a.owner_display_name,p_refund_key,
    amount/100.0,0,amount/100.0,'replacement_credit','Approved refund from original voucher '||v.id::text);
 ELSE
  UPDATE public.voucher SET value=value+amount/100.0,status='active',used_at=NULL WHERE id=v.id;
 END IF;
 INSERT INTO public.voucher_transaction(voucher_id,tenant_id,organization_id,owner_member_id,owner_display_name,
  allocation_id,booking_reference,member_id,amount,balance_before,balance_after,type,notes)
 VALUES(v.id,p_tenant_id,v.organization_id,v.member_id,a.owner_display_name,a.id,p_refund_key,p.member_id,
  amount/100.0,v.value,v.value+CASE WHEN replacement.id IS NULL THEN amount/100.0 ELSE 0 END,'cancellation_refund',
  CASE WHEN replacement.id IS NULL THEN 'Confirmed membership payment refund' ELSE 'Approved replacement voucher '||replacement.id::text END);
 result:=jsonb_build_object('voucherId',v.id,'ownerMemberId',v.member_id,'organizationId',v.organization_id,
  'amountMinor',amount,'cumulativeMinor',p_cumulative_minor,'replacementVoucherId',replacement.id);
 INSERT INTO public.voucher_allocation_refund(tenant_id,allocation_id,refund_key,cumulative_minor,result)
  VALUES(p_tenant_id,a.id,p_refund_key,p_cumulative_minor,result)
  ON CONFLICT(tenant_id,allocation_id,refund_key) DO UPDATE SET cumulative_minor=excluded.cumulative_minor,result=excluded.result,updated_at=now();
 PERFORM set_config('app.voucher_credit_write',coalesce(previous_write,''),true);
 PERFORM set_config('app.voucher_credit_reversal',coalesce(previous_reversal,''),true);
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION public.voucher_credit_refund_allocation(uuid,uuid,text,bigint,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.voucher_credit_refund_allocation(uuid,uuid,text,bigint,jsonb) TO service_role;
