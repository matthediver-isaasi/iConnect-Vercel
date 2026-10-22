BEGIN;
ALTER TABLE public.program_credit_purchase
  ADD COLUMN IF NOT EXISTS accounting_snapshot jsonb,
  ADD COLUMN IF NOT EXISTS accounting_status text NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS accounting_error text,
  ADD COLUMN IF NOT EXISTS accounting_provider text,
  ADD COLUMN IF NOT EXISTS accounting_invoice jsonb,
  ADD COLUMN IF NOT EXISTS accounting_tax jsonb,
  ADD COLUMN IF NOT EXISTS accounting_attempted_at timestamptz,
  ADD COLUMN IF NOT EXISTS accounting_steps jsonb NOT NULL DEFAULT '[]',
  ADD COLUMN IF NOT EXISTS accounting_lease uuid,
  ADD COLUMN IF NOT EXISTS accounting_lease_until timestamptz;

-- Capture authoritative amounts and owner-specific allocation labels in the
-- entitlement transaction, not from the retried browser request.
CREATE OR REPLACE FUNCTION public.snapshot_program_credit_accounting()
RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE t public.program_ticket_transaction%ROWTYPE; o public.organization%ROWTYPE;
  m public.member%ROWTYPE; contact_name text; cash numeric; voucher numeric;
BEGIN
  SELECT * INTO STRICT t FROM public.program_ticket_transaction
    WHERE id=(NEW.result->>'transaction_id')::uuid AND tenant_id=NEW.tenant_id;
  IF t.organization_id IS NOT NULL THEN
    SELECT * INTO STRICT o FROM public.organization WHERE id=t.organization_id AND tenant_id=NEW.tenant_id;
    contact_name:=o.name;
  ELSE
    SELECT * INTO STRICT m FROM public.member WHERE id=t.owner_member_id AND tenant_id=NEW.tenant_id;
    contact_name:=coalesce(nullif(trim(concat(to_jsonb(m)->>'first_name',' ',to_jsonb(m)->>'last_name')),''),m.email);
  END IF;
  voucher:=coalesce(t.voucher_amount,(NEW.result->'credit'->>'voucherMinor')::numeric/100,0);
  cash:=coalesce(t.cash_amount,t.total_cost_before_discount-coalesce(t.discount_amount_applied,0)-voucher-coalesce(t.training_fund_amount,0));
  NEW.accounting_snapshot := jsonb_build_object(
    'organizationName',contact_name,'email',t.member_email,'programName',t.program_name,
    'grossMinor',round(t.total_cost_before_discount*100),
    'discountMinor',round(coalesce(t.discount_amount_applied,0)*100),
    'remainingMinor',round(cash*100),
    'trainingFundMinor',round(coalesce(t.training_fund_amount,0)*100),
    'voucherMinor',round(voucher*100),
    'paymentMethod',t.payment_method,'paymentIntentId',t.stripe_payment_intent_id,
    'purchaseOrder',t.purchase_order_number,'currency','GBP',
    'allocations',coalesce(NEW.result->'credit'->'allocations','[]'::jsonb));
  RETURN NEW;
END $$;
CREATE TRIGGER snapshot_program_credit_accounting BEFORE INSERT ON public.program_credit_purchase
FOR EACH ROW EXECUTE FUNCTION public.snapshot_program_credit_accounting();
REVOKE ALL ON FUNCTION public.snapshot_program_credit_accounting() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.snapshot_program_credit_accounting() TO service_role;

CREATE OR REPLACE FUNCTION public.claim_program_credit_accounting(p_tenant_id uuid,p_purchase_key text,p_lease uuid)
RETURNS SETOF public.program_credit_purchase LANGUAGE sql SECURITY DEFINER SET search_path=public,pg_temp AS $$
  UPDATE public.program_credit_purchase SET accounting_lease=p_lease,accounting_lease_until=now()+interval '10 minutes'
  WHERE tenant_id=p_tenant_id AND purchase_key=p_purchase_key AND accounting_status<>'complete'
    AND (accounting_lease_until IS NULL OR accounting_lease_until<now())
  RETURNING *;
$$;
REVOKE ALL ON FUNCTION public.claim_program_credit_accounting(uuid,text,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.claim_program_credit_accounting(uuid,text,uuid) TO service_role;
COMMIT;
