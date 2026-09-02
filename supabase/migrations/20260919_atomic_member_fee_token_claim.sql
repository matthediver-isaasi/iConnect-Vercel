-- Serialize member fee-token claim/reuse for one tenant/member/year. The batch
-- requires this RPC so concurrent invocations cannot mint two active links or
-- silently replace a PO-submitted/completed token.

CREATE TABLE IF NOT EXISTS public.membership_fee_token (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  token text NOT NULL UNIQUE,
  tenant_id uuid NOT NULL,
  organization_id uuid,
  member_id uuid,
  membership_year text NOT NULL,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'po_submitted', 'paid', 'expired', 'cancelled')),
  final_cost numeric(12, 2),
  currency text DEFAULT 'GBP',
  tier_label text,
  cost_breakdown jsonb,
  po_number text,
  stripe_payment_intent_id text,
  stripe_client_secret text,
  recipient_email text,
  xero_invoice_id text,
  xero_invoice_number text,
  xero_online_invoice_url text,
  history_record_id uuid,
  paid_at timestamptz,
  expires_at timestamptz NOT NULL,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

ALTER TABLE public.membership_fee_token ADD COLUMN IF NOT EXISTS member_id uuid;
ALTER TABLE public.membership_fee_token ALTER COLUMN organization_id DROP NOT NULL;
CREATE INDEX IF NOT EXISTS idx_membership_fee_token_tenant_member
  ON public.membership_fee_token (tenant_id, member_id, membership_year);

CREATE OR REPLACE FUNCTION public.claim_member_fee_token_for_email(
  p_tenant_id uuid,
  p_member_id uuid,
  p_membership_year text,
  p_candidate_token text,
  p_expires_at timestamptz,
  p_snapshot jsonb DEFAULT '{}'::jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_pending public.membership_fee_token%ROWTYPE;
  v_row public.membership_fee_token%ROWTYPE;
  v_active_pending_count integer;
BEGIN
  IF p_tenant_id IS NULL OR p_member_id IS NULL OR NULLIF(trim(p_membership_year), '') IS NULL
     OR NULLIF(trim(p_candidate_token), '') IS NULL OR p_expires_at <= now() THEN
    RAISE EXCEPTION 'Invalid member fee token claim input' USING ERRCODE = '22023';
  END IF;

  -- Transaction-scoped and compatible with pooled database connections.
  PERFORM pg_advisory_xact_lock(hashtextextended(
    p_tenant_id::text || ':' || p_member_id::text || ':' || p_membership_year,
    0
  ));

  IF NOT EXISTS (
    SELECT 1 FROM public.member
    WHERE id = p_member_id AND tenant_id = p_tenant_id
  ) THEN
    RAISE EXCEPTION 'Member not found in tenant' USING ERRCODE = 'P0002';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.member_membership_history
    WHERE tenant_id = p_tenant_id
      AND member_id = p_member_id
      AND membership_year = p_membership_year
  ) THEN
    RETURN jsonb_build_object('outcome', 'already_recorded');
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.membership_fee_token
    WHERE tenant_id = p_tenant_id
      AND member_id = p_member_id
      AND membership_year = p_membership_year
      AND status = 'po_submitted'
  ) THEN
    RETURN jsonb_build_object('outcome', 'po_submitted');
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.membership_fee_token
    WHERE tenant_id = p_tenant_id
      AND member_id = p_member_id
      AND membership_year = p_membership_year
      AND status = 'paid'
  ) THEN
    RETURN jsonb_build_object('outcome', 'terminal');
  END IF;

  SELECT count(*)
    INTO v_active_pending_count
    FROM public.membership_fee_token
   WHERE tenant_id = p_tenant_id
     AND member_id = p_member_id
     AND membership_year = p_membership_year
     AND status = 'pending'
     AND expires_at > now();

  IF v_active_pending_count > 1 THEN
    RETURN jsonb_build_object('outcome', 'duplicate_active');
  END IF;

  SELECT *
    INTO v_pending
    FROM public.membership_fee_token
   WHERE tenant_id = p_tenant_id
     AND member_id = p_member_id
     AND membership_year = p_membership_year
     AND status = 'pending'
     AND expires_at > now()
   ORDER BY created_at DESC, id DESC
   LIMIT 1
   FOR UPDATE;

  IF FOUND THEN
    UPDATE public.membership_fee_token
       SET final_cost = NULLIF(p_snapshot->>'final_cost', '')::numeric,
           currency = COALESCE(NULLIF(p_snapshot->>'currency', ''), currency),
           tier_label = p_snapshot->>'tier_label',
           cost_breakdown = COALESCE(p_snapshot->'cost_breakdown', '{}'::jsonb),
           po_number = NULLIF(p_snapshot->>'po_number', ''),
           recipient_email = NULLIF(p_snapshot->>'recipient_email', ''),
           xero_invoice_id = NULLIF(p_snapshot->>'xero_invoice_id', ''),
           xero_invoice_number = NULLIF(p_snapshot->>'xero_invoice_number', ''),
           xero_online_invoice_url = NULLIF(p_snapshot->>'xero_online_invoice_url', ''),
           history_record_id = NULLIF(p_snapshot->>'history_record_id', '')::uuid,
           updated_at = now()
     WHERE id = v_pending.id
     RETURNING * INTO v_row;
  ELSE
    INSERT INTO public.membership_fee_token (
      token, tenant_id, organization_id, member_id, membership_year, status,
      final_cost, currency, tier_label, cost_breakdown, po_number,
      recipient_email, xero_invoice_id, xero_invoice_number,
      xero_online_invoice_url, history_record_id, expires_at
    ) VALUES (
      p_candidate_token, p_tenant_id, NULL, p_member_id, p_membership_year, 'pending',
      NULLIF(p_snapshot->>'final_cost', '')::numeric,
      COALESCE(NULLIF(p_snapshot->>'currency', ''), 'GBP'),
      p_snapshot->>'tier_label',
      COALESCE(p_snapshot->'cost_breakdown', '{}'::jsonb),
      NULLIF(p_snapshot->>'po_number', ''),
      NULLIF(p_snapshot->>'recipient_email', ''),
      NULLIF(p_snapshot->>'xero_invoice_id', ''),
      NULLIF(p_snapshot->>'xero_invoice_number', ''),
      NULLIF(p_snapshot->>'xero_online_invoice_url', ''),
      NULLIF(p_snapshot->>'history_record_id', '')::uuid,
      p_expires_at
    )
    RETURNING * INTO v_row;
  END IF;

  RETURN jsonb_build_object(
    'outcome', 'claimed',
    'id', v_row.id,
    'token', v_row.token,
    'expires_at', v_row.expires_at,
    'reused', v_pending.id IS NOT NULL
  );
END;
$$;

REVOKE ALL ON FUNCTION public.claim_member_fee_token_for_email(uuid, uuid, text, text, timestamptz, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.claim_member_fee_token_for_email(uuid, uuid, text, text, timestamptz, jsonb) FROM anon;
REVOKE ALL ON FUNCTION public.claim_member_fee_token_for_email(uuid, uuid, text, text, timestamptz, jsonb) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.claim_member_fee_token_for_email(uuid, uuid, text, text, timestamptz, jsonb) TO service_role;