ALTER TABLE public.membership_voucher_settlement ADD COLUMN accounting_binding jsonb;
CREATE FUNCTION public.membership_voucher_pin_accounting(p_tenant_id uuid,p_settlement_id uuid,p_binding jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE s public.membership_voucher_settlement%ROWTYPE;
BEGIN
 SELECT * INTO s FROM public.membership_voucher_settlement WHERE tenant_id=p_tenant_id AND id=p_settlement_id FOR UPDATE;
 IF NOT FOUND OR coalesce(p_binding->>'provider','') NOT IN ('xero','quickbooks')
  OR nullif(p_binding->>'companyId','') IS NULL OR p_binding->>'companyId'='PENDING_SELECTION'
  OR nullif(p_binding->>'connectionId','') IS NULL THEN RAISE EXCEPTION 'Invalid membership accounting company binding'; END IF;
 IF s.accounting_binding IS NOT NULL AND s.accounting_binding<>p_binding THEN
  RAISE EXCEPTION 'Accounting connection/company changed; reconcile the original membership purchase before retrying';
 END IF;
 IF s.accounting_binding IS NULL AND (s.accounting_attempted_at IS NOT NULL
   OR EXISTS(SELECT 1 FROM public.membership_voucher_collection WHERE settlement_id=s.id AND accounting_attempted_at IS NOT NULL)) THEN
  RAISE EXCEPTION 'Historical invoice attempt has no company binding; operator reconciliation required before retry';
 END IF;
 IF s.accounting_provider IS NOT NULL AND s.accounting_provider<>p_binding->>'provider' THEN
  RAISE EXCEPTION 'Accounting provider differs from the original membership purchase';
 END IF;
 UPDATE public.membership_voucher_settlement SET accounting_binding=p_binding,accounting_provider=p_binding->>'provider'
  WHERE id=s.id RETURNING * INTO s;
 RETURN to_jsonb(s);
END $$;
REVOKE ALL ON FUNCTION public.membership_voucher_pin_accounting(uuid,uuid,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.membership_voucher_pin_accounting(uuid,uuid,jsonb) TO service_role;
