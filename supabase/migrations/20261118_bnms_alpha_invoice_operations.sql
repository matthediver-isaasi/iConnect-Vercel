BEGIN;
CREATE TABLE IF NOT EXISTS public.bnms_alpha_invoice_operations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  plan_id uuid NOT NULL REFERENCES public.membership_payment_plans(id),
  payment_id text NOT NULL UNIQUE,
  request_identity jsonb NOT NULL,
  claim_token uuid NOT NULL DEFAULT gen_random_uuid(),
  invoice_id text UNIQUE,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  linked_at timestamptz,
  CHECK ((invoice_id IS NULL) = (linked_at IS NULL))
);
ALTER TABLE public.bnms_alpha_invoice_operations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.bnms_alpha_invoice_operations FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.bnms_alpha_invoice_operations TO service_role;

-- Only the first committed claimant can submit. A crash at ANY point before
-- durable linkage is permanently uncertain: manual reconciliation is required.
-- There is deliberately no lease expiry/reset/reclaim/delete RPC.
CREATE OR REPLACE FUNCTION public.bnms_alpha_claim_invoice(
  p_tenant uuid, p_plan uuid, p_payment text, p_identity jsonb
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE op public.bnms_alpha_invoice_operations; inserted boolean;
BEGIN
  IF p_tenant IS DISTINCT FROM 'ff2df806-b321-4254-b651-3af11fccf1db'::uuid
    OR p_identity IS NULL OR NOT EXISTS (
      SELECT 1 FROM public.bnms_dd_alpha_adoption a
      JOIN public.bnms_dd_alpha_release r ON r.adoption_id=a.id AND r.plan_id=a.plan_id AND r.tenant_id=a.tenant_id
      JOIN public.gocardless_payments p ON p.plan_id=a.plan_id AND p.tenant_id=a.tenant_id
      JOIN public.gocardless_collection_reservations c ON c.plan_id=a.plan_id AND c.tenant_id=a.tenant_id
        AND c.gocardless_payment_id=p.gocardless_payment_id AND c.billing_agreement_id=a.agreement_id
      WHERE a.tenant_id=p_tenant AND a.plan_id=p_plan AND p.gocardless_payment_id=p_payment
        AND a.manifest_sha256='3aff20a6e04338c3b3532d57c6be4b8395afa5ff8d5dbbe878daab52017f395a'
        AND p.gocardless_mandate_id=a.mandate_id AND p.environment='live'
        AND p.status IN ('confirmed','paid_out') AND p.currency='GBP'
        AND p.amount_minor=c.amount_minor AND c.currency=p.currency
        AND c.due_date>='2026-10-01'::date
        AND (p_identity->>'amountMinor')::integer=p.amount_minor
        AND p_identity->>'currency'='GBP'
        AND p_identity->>'contactId'=r.evidence#>>'{accounting,contactId}'
        AND p_identity->>'xeroTenantId'='3d57dce6-2205-462f-abf6-9c7cbf00be23'
        AND p_identity->>'revenueCode'=r.evidence#>>'{accounting,revenueCode}'
        AND p_identity->>'paymentReference'='GoCardless DD: '||p_payment
        AND length(p_identity->>'idempotencyKey')>0 AND length(p_identity->>'paymentIdempotencyKey')>0
    ) THEN RAISE EXCEPTION 'Alpha invoice canonical ownership/collection mismatch'; END IF;
  INSERT INTO public.bnms_alpha_invoice_operations(tenant_id,plan_id,payment_id,request_identity)
    VALUES(p_tenant,p_plan,p_payment,p_identity) ON CONFLICT(payment_id) DO NOTHING RETURNING * INTO op;
  inserted := FOUND;
  IF NOT inserted THEN
    SELECT * INTO STRICT op FROM public.bnms_alpha_invoice_operations WHERE payment_id=p_payment FOR UPDATE;
    IF op.tenant_id IS DISTINCT FROM p_tenant OR op.plan_id IS DISTINCT FROM p_plan
      OR op.request_identity IS DISTINCT FROM p_identity THEN
      RAISE EXCEPTION 'Alpha invoice request identity changed; review required';
    END IF;
    IF op.invoice_id IS NULL THEN
      RAISE EXCEPTION 'Alpha invoice submission outcome uncertain; review required; never re-POST';
    END IF;
  END IF;
  RETURN jsonb_build_object('id',op.id,'invoice_id',op.invoice_id,
    'token',CASE WHEN inserted THEN op.claim_token ELSE NULL END);
END $$;

CREATE OR REPLACE FUNCTION public.bnms_alpha_link_invoice(p_operation uuid,p_token uuid,p_invoice text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE op public.bnms_alpha_invoice_operations;
BEGIN
  IF p_invoice IS NULL OR p_invoice !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    RAISE EXCEPTION 'Alpha invoice ID invalid';
  END IF;
  SELECT * INTO STRICT op FROM public.bnms_alpha_invoice_operations WHERE id=p_operation FOR UPDATE;
  IF op.claim_token IS DISTINCT FROM p_token OR (op.invoice_id IS NOT NULL AND op.invoice_id<>p_invoice) THEN
    RAISE EXCEPTION 'Alpha invoice linkage ownership mismatch';
  END IF;
  IF op.invoice_id IS NULL THEN
    UPDATE public.bnms_alpha_invoice_operations SET invoice_id=p_invoice,linked_at=clock_timestamp() WHERE id=op.id;
  END IF;
  RETURN jsonb_build_object('id',op.id,'invoice_id',p_invoice);
END $$;
REVOKE ALL ON FUNCTION public.bnms_alpha_claim_invoice(uuid,uuid,text,jsonb) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.bnms_alpha_link_invoice(uuid,uuid,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.bnms_alpha_claim_invoice(uuid,uuid,text,jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.bnms_alpha_link_invoice(uuid,uuid,text) TO service_role;

CREATE OR REPLACE FUNCTION public.bnms_alpha_assert_invoice(
  p_tenant uuid,p_plan uuid,p_payment text,p_invoice text,p_contact text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE op public.bnms_alpha_invoice_operations;
BEGIN
  SELECT * INTO op FROM public.bnms_alpha_invoice_operations
    WHERE tenant_id=p_tenant AND plan_id=p_plan AND payment_id=p_payment
      AND invoice_id=p_invoice AND request_identity->>'contactId'=p_contact;
  IF NOT FOUND THEN RAISE EXCEPTION 'Alpha invoice retry lacks exact durable collection linkage; review required'; END IF;
  RETURN jsonb_build_object('id',op.id,'invoice_id',op.invoice_id);
END $$;
REVOKE ALL ON FUNCTION public.bnms_alpha_assert_invoice(uuid,uuid,text,text,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.bnms_alpha_assert_invoice(uuid,uuid,text,text,text) TO service_role;
COMMIT;