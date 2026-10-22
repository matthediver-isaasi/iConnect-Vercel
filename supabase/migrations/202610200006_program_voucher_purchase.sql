-- Task 5241: programme redemption, ledger and entitlement commit atomically.
BEGIN;
-- Deployed program_ticket_transaction has no payment provenance columns.
-- Add nullable fields without relabelling or changing historical purchases.
ALTER TABLE public.program_ticket_transaction
  ADD COLUMN IF NOT EXISTS payment_method text,
  ADD COLUMN IF NOT EXISTS stripe_payment_intent_id text,
  ADD COLUMN IF NOT EXISTS cash_amount numeric,
  ADD COLUMN IF NOT EXISTS voucher_amount numeric,
  ADD COLUMN IF NOT EXISTS training_fund_amount numeric;
CREATE TABLE IF NOT EXISTS public.program_credit_purchase (
  tenant_id uuid NOT NULL REFERENCES public.tenant(id),
  purchase_key text NOT NULL,
  binding text NOT NULL,
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,purchase_key)
);
ALTER TABLE public.program_credit_purchase ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.program_credit_purchase FROM PUBLIC,anon,authenticated;
GRANT ALL ON public.program_credit_purchase TO service_role;
CREATE POLICY program_credit_purchase_service ON public.program_credit_purchase TO service_role USING(true) WITH CHECK(true);

CREATE OR REPLACE FUNCTION public.complete_program_credit_purchase(
  p_tenant_id uuid,p_purchase_key text,p_quote jsonb,p_payment_method text,
  p_payment_intent_id text,p_purchase_order text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE existing public.program_credit_purchase%ROWTYPE; org public.organization%ROWTYPE;
  member_row public.member%ROWTYPE; allocation jsonb; transaction_id uuid;
  new_balance numeric; training_fund_before numeric;
  tf numeric := (p_quote->>'trainingFundMinor')::numeric/100;
  cash numeric := (p_quote->>'remainingMinor')::numeric/100;
  discount public.discount_code%ROWTYPE; usage public.discount_code_usage%ROWTYPE;
  targeted boolean; result jsonb; ids uuid[];
BEGIN
  IF p_tenant_id IS NULL OR coalesce(length(p_purchase_key),0) NOT BETWEEN 1 AND 200
    OR (p_quote->>'tenantId')::uuid<>p_tenant_id
    OR p_payment_method NOT IN ('card','account') THEN RAISE EXCEPTION 'Invalid programme purchase'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(p_tenant_id::text||':'||p_purchase_key,0));
  SELECT * INTO existing FROM public.program_credit_purchase
    WHERE tenant_id=p_tenant_id AND purchase_key=p_purchase_key;
  IF FOUND THEN
    IF existing.binding<>p_quote->>'binding' THEN RAISE EXCEPTION 'Purchase request changed'; END IF;
    RETURN existing.result;
  END IF;
  SELECT * INTO STRICT member_row FROM public.member WHERE id=(p_quote->>'memberId')::uuid AND tenant_id=p_tenant_id;
  SELECT * INTO STRICT org FROM public.organization
    WHERE id=member_row.organization_id AND id=(p_quote->>'organizationId')::uuid AND tenant_id=p_tenant_id FOR UPDATE;
  -- Freeze the locked pre-debit balance independently of the mutable row.
  -- The ledger must describe the one actual deduction, including on retries.
  training_fund_before := coalesce(org.training_fund_balance,0);
  IF tf<0 OR cash<0 OR tf>coalesce(org.training_fund_balance,0) THEN RAISE EXCEPTION 'Training fund balance changed'; END IF;
  IF tf>0 AND jsonb_array_length(coalesce(to_jsonb(org.training_fund_allowed_role_ids),'[]'))>0
    AND NOT coalesce(to_jsonb(org.training_fund_allowed_role_ids),'[]') ? member_row.role_id::text
    THEN RAISE EXCEPTION 'Training fund role is not permitted'; END IF;
  IF cash>0 AND p_payment_method='card' AND p_payment_intent_id IS NULL THEN RAISE EXCEPTION 'Verified payment required'; END IF;
  IF cash>0 AND p_payment_method='account' AND coalesce(length(trim(p_purchase_order)),0)=0 THEN RAISE EXCEPTION 'Purchase order required'; END IF;
  IF p_quote->>'discountId' IS NOT NULL THEN
    SELECT * INTO STRICT discount FROM public.discount_code WHERE id=(p_quote->>'discountId')::uuid AND tenant_id=p_tenant_id FOR UPDATE;
    targeted := discount.organization_id IS NOT NULL OR discount.member_id IS NOT NULL
      OR discount.role_id IS NOT NULL OR discount.member_group_id IS NOT NULL;
    IF targeted THEN
      SELECT * INTO usage FROM public.discount_code_usage WHERE discount_code_id=discount.id
        AND CASE WHEN discount.organization_id IS NOT NULL THEN organization_id=org.id ELSE member_id=member_row.id END FOR UPDATE;
    END IF;
    IF NOT discount.is_active OR discount.expires_at<=now()
      OR (discount.max_usage_count IS NOT NULL AND
        CASE WHEN targeted THEN coalesce(usage.usage_count,0) ELSE coalesce(discount.current_usage_count,0) END >= discount.max_usage_count)
      THEN RAISE EXCEPTION 'Discount is no longer available'; END IF;
    IF targeted THEN
      IF usage.id IS NULL THEN
        INSERT INTO public.discount_code_usage(tenant_id,discount_code_id,organization_id,member_id,usage_count)
        VALUES(p_tenant_id,discount.id,org.id,CASE WHEN discount.organization_id IS NULL THEN member_row.id END,1);
      ELSE UPDATE public.discount_code_usage SET usage_count=coalesce(usage_count,0)+1 WHERE id=usage.id; END IF;
    ELSE UPDATE public.discount_code SET current_usage_count=coalesce(current_usage_count,0)+1 WHERE id=discount.id; END IF;
  END IF;
  SELECT coalesce(array_agg(value::uuid),'{}'::uuid[]) INTO ids FROM jsonb_array_elements_text(p_quote->'voucherIds');
  IF cardinality(ids)>0 THEN
    allocation := public.voucher_credit_reserve(p_tenant_id,p_purchase_key,member_row.id,member_row.id,ids,
      (p_quote->>'totalMinor')::bigint-(p_quote->>'trainingFundMinor')::bigint,'GBP',true,(p_quote->>'manualOrder')::boolean);
    IF (allocation->>'voucherMinor')::bigint<>(p_quote->>'voucherMinor')::bigint THEN RAISE EXCEPTION 'Credit balance changed'; END IF;
    PERFORM public.voucher_credit_transition(p_tenant_id,p_purchase_key,'commit',NULL);
  END IF;
  new_balance := coalesce((org.program_ticket_balances->>(p_quote->>'programTag'))::numeric,0)+(p_quote->>'tickets')::numeric;
  UPDATE public.organization SET
    program_ticket_balances=jsonb_set(coalesce(program_ticket_balances,'{}'::jsonb),ARRAY[p_quote->>'programTag'],to_jsonb(new_balance)),
    training_fund_balance=training_fund_before-tf
    WHERE id=org.id;
  INSERT INTO public.program_ticket_transaction(tenant_id,organization_id,program_name,transaction_type,
    quantity,member_email,payment_method,stripe_payment_intent_id,purchase_order_number,booking_reference,
    discount_code_id,discount_amount_applied,total_cost_before_discount,notes,cash_amount,voucher_amount,training_fund_amount)
  VALUES(p_tenant_id,org.id,p_quote->>'programName','purchase',(p_quote->>'tickets')::numeric,
    member_row.email,p_payment_method,p_payment_intent_id,p_purchase_order,p_purchase_key,
    (p_quote->>'discountId')::uuid,(p_quote->>'discountMinor')::numeric/100,(p_quote->>'grossMinor')::numeric/100,
    'Programme purchase; credit funding: '||coalesce(allocation->'allocations','[]'::jsonb)::text,
    cash,coalesce((allocation->>'voucherMinor')::numeric,0)/100,tf)
  RETURNING id INTO transaction_id;
  IF tf>0 THEN
    INSERT INTO public.training_fund_transaction(tenant_id,organization_id,type,amount,balance_before,balance_after,reason)
    VALUES(p_tenant_id,org.id,'booking_usage',tf,training_fund_before,training_fund_before-tf,'Programme purchase '||p_purchase_key);
  END IF;
  result:=jsonb_build_object('success',true,'transaction_id',transaction_id,'new_balance',new_balance,
    'organization_id',org.id,'credit',allocation);
  INSERT INTO public.program_credit_purchase(tenant_id,purchase_key,binding,result)
    VALUES(p_tenant_id,p_purchase_key,p_quote->>'binding',result);
  RETURN result;
END $$;
REVOKE ALL ON FUNCTION public.complete_program_credit_purchase(uuid,text,jsonb,text,text,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.complete_program_credit_purchase(uuid,text,jsonb,text,text,text) TO service_role;
COMMIT;
