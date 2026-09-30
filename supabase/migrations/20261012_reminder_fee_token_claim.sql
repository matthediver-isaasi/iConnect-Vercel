-- Reminder preparation is fail-closed until this migration is applied.
CREATE OR REPLACE FUNCTION public.claim_reminder_fee_token(
  p_tenant_id uuid, p_member_id uuid, p_organization_id uuid,
  p_membership_year text, p_candidate_token text, p_expires_at timestamptz,
  p_snapshot jsonb
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  existing public.membership_fee_token%ROWTYPE;
  n integer;
BEGIN
  IF p_tenant_id IS NULL OR NULLIF(trim(p_membership_year),'') IS NULL OR p_expires_at <= now() THEN
    RAISE EXCEPTION 'Invalid fee token claim input';
  END IF;
  IF (p_member_id IS NULL) = (p_organization_id IS NULL) THEN
    RAISE EXCEPTION 'Exactly one membership owner is required';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(
    p_tenant_id::text || ':' || coalesce(p_member_id, p_organization_id)::text || ':' || p_membership_year, 0));
  IF p_member_id IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM public.member WHERE id=p_member_id AND tenant_id=p_tenant_id) THEN
      RAISE EXCEPTION 'Member not found in tenant';
    END IF;
    IF EXISTS (SELECT 1 FROM public.member_membership_history WHERE tenant_id=p_tenant_id
      AND member_id=p_member_id AND membership_year=p_membership_year
      AND (payment_status='paid' OR paid_at IS NOT NULL)) THEN
      RETURN jsonb_build_object('error','Successor term is already paid');
    END IF;
  ELSE
    IF NOT EXISTS (SELECT 1 FROM public.organization WHERE id=p_organization_id AND tenant_id=p_tenant_id) THEN
      RAISE EXCEPTION 'Organisation not found in tenant';
    END IF;
    IF EXISTS (SELECT 1 FROM public.organisation_membership_history WHERE tenant_id=p_tenant_id
      AND organization_id=p_organization_id AND membership_year=p_membership_year
      AND (payment_status='paid' OR paid_at IS NOT NULL)) THEN
      RETURN jsonb_build_object('error','Successor term is already paid');
    END IF;
  END IF;
  IF EXISTS (SELECT 1 FROM public.membership_fee_token
    WHERE tenant_id=p_tenant_id AND membership_year=p_membership_year
      AND member_id IS NOT DISTINCT FROM p_member_id
      AND organization_id IS NOT DISTINCT FROM p_organization_id AND status='paid') THEN
    RETURN jsonb_build_object('error', 'Successor payment is already complete');
  END IF;
  SELECT count(*) INTO n FROM public.membership_fee_token
    WHERE tenant_id=p_tenant_id AND membership_year=p_membership_year
      AND member_id IS NOT DISTINCT FROM p_member_id AND organization_id IS NOT DISTINCT FROM p_organization_id
      AND status IN ('pending','po_submitted') AND expires_at > now();
  IF n > 1 THEN RETURN jsonb_build_object('error', 'Multiple active fee links require reconciliation'); END IF;
  SELECT * INTO existing FROM public.membership_fee_token
    WHERE tenant_id=p_tenant_id AND membership_year=p_membership_year
      AND member_id IS NOT DISTINCT FROM p_member_id AND organization_id IS NOT DISTINCT FROM p_organization_id
      AND status IN ('pending','po_submitted')
    ORDER BY (expires_at > now()) DESC, created_at DESC LIMIT 1 FOR UPDATE;
  IF FOUND THEN
    IF existing.expires_at <= now() AND existing.stripe_payment_intent_id IS NOT NULL THEN
      RETURN jsonb_build_object('error','Expired submitted payment requires reconciliation');
    END IF;
    IF p_snapshot->>'preparation_mode' = 'email' THEN
      IF existing.status='pending' AND existing.expires_at > now() THEN
        IF existing.stripe_payment_intent_id IS NOT NULL
          AND (existing.final_cost IS DISTINCT FROM (p_snapshot->>'final_cost')::numeric
            OR existing.currency IS DISTINCT FROM p_snapshot->>'currency'
            OR existing.cost_breakdown->'totalWithVat' IS DISTINCT FROM p_snapshot->'cost_breakdown'->'totalWithVat') THEN
          RETURN jsonb_build_object('error','An in-flight payment quote cannot be repriced');
        END IF;
        UPDATE public.membership_fee_token SET
          final_cost=(p_snapshot->>'final_cost')::numeric, currency=p_snapshot->>'currency',
          tier_label=p_snapshot->>'tier_label', cost_breakdown=p_snapshot->'cost_breakdown',
          po_number=p_snapshot->>'po_number', recipient_email=p_snapshot->>'recipient_email',
          xero_invoice_id=coalesce(p_snapshot->>'xero_invoice_id',xero_invoice_id),
          xero_invoice_number=coalesce(p_snapshot->>'xero_invoice_number',xero_invoice_number),
          xero_online_invoice_url=coalesce(p_snapshot->>'xero_online_invoice_url',xero_online_invoice_url),
          history_record_id=coalesce((p_snapshot->>'history_record_id')::uuid,history_record_id),
          updated_at=now()
        WHERE id=existing.id RETURNING * INTO existing;
        RETURN to_jsonb(existing);
      END IF;
      -- Preserve ordinary Email Fees behaviour for an expired or submitted quote.
    ELSE
      IF p_snapshot->>'history_record_id' IS NOT NULL
        AND existing.cost_breakdown->'renewalQuote' IS NOT NULL
        AND existing.history_record_id IS DISTINCT FROM (p_snapshot->>'history_record_id')::uuid THEN
        IF existing.history_record_id IS NOT NULL
          OR existing.final_cost IS DISTINCT FROM (p_snapshot->>'final_cost')::numeric
          OR existing.currency IS DISTINCT FROM p_snapshot->>'currency'
          OR coalesce(existing.cost_breakdown->'totalWithVat',to_jsonb(existing.final_cost))
            IS DISTINCT FROM coalesce(p_snapshot->'cost_breakdown'->'totalWithVat',p_snapshot->'final_cost')
          OR coalesce(existing.cost_breakdown->'vatAmount','0'::jsonb)
            IS DISTINCT FROM coalesce(p_snapshot->'cost_breakdown'->'vatAmount','0'::jsonb) THEN
          RETURN jsonb_build_object('error','Existing payment quote does not match the successor invoice');
        END IF;
        UPDATE public.membership_fee_token SET history_record_id=(p_snapshot->>'history_record_id')::uuid,
          xero_invoice_id=p_snapshot->>'xero_invoice_id',xero_invoice_number=p_snapshot->>'xero_invoice_number',
          xero_online_invoice_url=p_snapshot->>'xero_online_invoice_url'
        WHERE id=existing.id RETURNING * INTO existing;
      END IF;
      IF existing.cost_breakdown->'renewalQuote' IS NULL THEN
        IF existing.final_cost IS DISTINCT FROM (p_snapshot->>'final_cost')::numeric
          OR existing.currency IS DISTINCT FROM p_snapshot->>'currency'
          OR existing.history_record_id IS DISTINCT FROM (p_snapshot->>'history_record_id')::uuid
          OR (coalesce(existing.cost_breakdown,'{}'::jsonb) - 'renewalQuote')
            IS DISTINCT FROM (coalesce(p_snapshot->'cost_breakdown','{}'::jsonb) - 'renewalQuote') THEN
          RETURN jsonb_build_object('error', 'Existing fee link differs from the successor quote; review required');
        END IF;
        UPDATE public.membership_fee_token
          SET cost_breakdown = coalesce(cost_breakdown,'{}'::jsonb)
            || jsonb_build_object('renewalQuote', p_snapshot->'cost_breakdown'->'renewalQuote')
          WHERE id=existing.id RETURNING * INTO existing;
      END IF;
    IF existing.expires_at > now() THEN
      RETURN to_jsonb(existing);
    END IF;
    IF existing.stripe_payment_intent_id IS NOT NULL OR existing.status='po_submitted' THEN
      RETURN jsonb_build_object('error', 'Expired submitted payment requires reconciliation');
    END IF;
    -- Preserve expired quotes (especially immutable rolling commitments).
    p_snapshot := to_jsonb(existing);
    END IF;
  END IF;
  INSERT INTO public.membership_fee_token (
    tenant_id,member_id,organization_id,membership_year,token,expires_at,
    final_cost,currency,tier_label,cost_breakdown,recipient_email,history_record_id,po_number,
    xero_invoice_id,xero_invoice_number,xero_online_invoice_url
  ) VALUES (
    p_tenant_id,p_member_id,p_organization_id,p_membership_year,p_candidate_token,p_expires_at,
    (p_snapshot->>'final_cost')::numeric,p_snapshot->>'currency',p_snapshot->>'tier_label',
    p_snapshot->'cost_breakdown',p_snapshot->>'recipient_email',(p_snapshot->>'history_record_id')::uuid,p_snapshot->>'po_number',
    p_snapshot->>'xero_invoice_id',p_snapshot->>'xero_invoice_number',p_snapshot->>'xero_online_invoice_url'
  ) RETURNING * INTO existing;
  RETURN to_jsonb(existing);
END;
$$;
REVOKE ALL ON FUNCTION public.claim_reminder_fee_token(uuid,uuid,uuid,text,text,timestamptz,jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_reminder_fee_token(uuid,uuid,uuid,text,text,timestamptz,jsonb) TO service_role;