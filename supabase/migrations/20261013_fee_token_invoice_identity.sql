-- Add provider identity without rewriting any historical invoice references.
ALTER TABLE public.membership_fee_token
  ADD COLUMN IF NOT EXISTS accounting_provider text,
  ADD COLUMN IF NOT EXISTS accounting_invoice_id text,
  ADD COLUMN IF NOT EXISTS accounting_invoice_number text,
  ADD COLUMN IF NOT EXISTS accounting_online_invoice_url text;

-- Retain the existing claim implementation and its price/lease protections.
DO $$
BEGIN
  IF to_regprocedure('public.claim_reminder_fee_token_pre_identity(uuid,uuid,uuid,text,text,timestamptz,jsonb)') IS NULL THEN
    ALTER FUNCTION public.claim_reminder_fee_token(uuid,uuid,uuid,text,text,timestamptz,jsonb)
      RENAME TO claim_reminder_fee_token_pre_identity;
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION public.claim_reminder_fee_token_pre_identity(uuid,uuid,uuid,text,text,timestamptz,jsonb) FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.claim_reminder_fee_token(
  p_tenant_id uuid, p_member_id uuid, p_organization_id uuid,
  p_membership_year text, p_candidate_token text, p_expires_at timestamptz,
  p_snapshot jsonb
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE
  prior public.membership_fee_token%ROWTYPE;
  result jsonb;
  provider text;
  invoice_id text;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(
    p_tenant_id::text || ':' || coalesce(p_member_id,p_organization_id)::text || ':' || p_membership_year,0));
  SELECT * INTO prior FROM public.membership_fee_token
    WHERE tenant_id=p_tenant_id AND membership_year=p_membership_year
    AND member_id IS NOT DISTINCT FROM p_member_id AND organization_id IS NOT DISTINCT FROM p_organization_id
    AND status IN ('pending','po_submitted')
    ORDER BY (expires_at > now()) DESC,created_at DESC LIMIT 1 FOR UPDATE;
  provider := nullif(p_snapshot->>'accounting_provider','');
  invoice_id := nullif(p_snapshot->>'accounting_invoice_id','');
  IF (provider IS NULL) <> (invoice_id IS NULL)
    OR (provider IS NOT NULL AND provider NOT IN ('xero','quickbooks')) THEN
    RETURN jsonb_build_object('error','Invalid saved invoice provider identity');
  END IF;
  IF provider='quickbooks' AND nullif(p_snapshot->>'xero_invoice_id','') IS NOT NULL THEN
    RETURN jsonb_build_object('error','Conflicting invoice provider fields');
  END IF;
  IF prior.accounting_invoice_id IS NOT NULL AND invoice_id IS NOT NULL
    AND (prior.accounting_invoice_id IS DISTINCT FROM invoice_id OR prior.accounting_provider IS DISTINCT FROM provider) THEN
    RETURN jsonb_build_object('error','Existing fee link invoice identity differs; reconciliation required');
  END IF;
  IF prior.history_record_id IS NOT NULL AND p_snapshot->>'history_record_id' IS NOT NULL
    AND prior.history_record_id IS DISTINCT FROM (p_snapshot->>'history_record_id')::uuid THEN
    RETURN jsonb_build_object('error','Existing fee link history differs; reconciliation required');
  END IF;
  IF prior.xero_invoice_id IS NOT NULL AND invoice_id IS NOT NULL
    AND prior.xero_invoice_id IS DISTINCT FROM invoice_id THEN
    RETURN jsonb_build_object('error','Existing legacy invoice differs; reconciliation required');
  END IF;
  IF prior.status='po_submitted' OR prior.stripe_payment_intent_id IS NOT NULL THEN
    IF prior.expires_at <= now() THEN
      RETURN jsonb_build_object('error','Expired submitted payment requires reconciliation');
    END IF;
    -- A submitted PO or card intent commits the entire saved quote, not just
    -- its net total. Reuse it without refreshing prices, terms or identity.
    RETURN to_jsonb(prior);
  END IF;
  -- Generic identity survives expiry replacement and calls without fresh invoice metadata.
  IF invoice_id IS NULL AND prior.accounting_invoice_id IS NOT NULL THEN
    provider := prior.accounting_provider;
    invoice_id := prior.accounting_invoice_id;
    p_snapshot := p_snapshot || jsonb_build_object(
      'accounting_provider',provider,'accounting_invoice_id',invoice_id,
      'accounting_invoice_number',prior.accounting_invoice_number,
      'accounting_online_invoice_url',prior.accounting_online_invoice_url);
  END IF;
  result := public.claim_reminder_fee_token_pre_identity(
    p_tenant_id,p_member_id,p_organization_id,p_membership_year,p_candidate_token,p_expires_at,p_snapshot);
  IF result->>'error' IS NOT NULL OR result->>'id' IS NULL THEN RETURN result; END IF;
  IF invoice_id IS NOT NULL THEN
    UPDATE public.membership_fee_token SET
      accounting_provider=provider, accounting_invoice_id=invoice_id,
      accounting_invoice_number=coalesce(accounting_invoice_number,p_snapshot->>'accounting_invoice_number'),
      accounting_online_invoice_url=coalesce(accounting_online_invoice_url,p_snapshot->>'accounting_online_invoice_url'),
      xero_invoice_id=CASE WHEN provider='quickbooks' THEN NULL ELSE xero_invoice_id END,
      xero_invoice_number=CASE WHEN provider='quickbooks' THEN NULL ELSE xero_invoice_number END,
      xero_online_invoice_url=CASE WHEN provider='quickbooks' THEN NULL ELSE xero_online_invoice_url END
      WHERE id=(result->>'id')::uuid RETURNING to_jsonb(membership_fee_token.*) INTO result;
  END IF;
  RETURN result;
END;
$$;
REVOKE ALL ON FUNCTION public.claim_reminder_fee_token(uuid,uuid,uuid,text,text,timestamptz,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.claim_reminder_fee_token(uuid,uuid,uuid,text,text,timestamptz,jsonb) TO service_role;