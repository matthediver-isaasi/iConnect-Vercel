-- Apply after the membership term locks, before enabling voucher checkout.
ALTER TABLE public.membership_payment_term_claim ADD COLUMN provider_basis jsonb;
ALTER TABLE public.membership_payment_term_claim ADD COLUMN provider_attempted_at timestamptz;
ALTER TABLE public.membership_payment_term_claim ADD COLUMN provider_payment_id text;
CREATE UNIQUE INDEX membership_payment_term_source ON public.membership_payment_term_claim(tenant_id,source_key);
CREATE FUNCTION public.membership_payment_start_provider(p_tenant_id uuid,p_source_key text,p_basis jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE c public.membership_payment_term_claim%ROWTYPE;
BEGIN
 SELECT * INTO c FROM public.membership_payment_term_claim WHERE tenant_id=p_tenant_id AND source_key=p_source_key FOR UPDATE;
 IF NOT FOUND OR c.rail<>'create_payment' THEN RAISE EXCEPTION 'Membership payment rail has not been claimed'; END IF;
 IF c.provider_basis IS NOT NULL AND c.provider_basis<>p_basis THEN
  RAISE EXCEPTION 'Membership price changed after a provider attempt; reconcile the original payment first';
 END IF;
 IF c.provider_payment_id IS NULL AND c.provider_attempted_at<now()-interval '23 hours' THEN
  RAISE EXCEPTION 'Uncertain provider attempt requires reconciliation; no replacement payment created';
 END IF;
 UPDATE public.membership_payment_term_claim SET provider_basis=p_basis,
  provider_attempted_at=coalesce(provider_attempted_at,now())
  WHERE tenant_id=p_tenant_id AND source_key=p_source_key RETURNING * INTO c;
 RETURN to_jsonb(c);
END $$;
REVOKE ALL ON FUNCTION public.membership_payment_start_provider(uuid,text,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.membership_payment_start_provider(uuid,text,jsonb) TO service_role;
