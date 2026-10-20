-- Prerequisite: 20260920_rolling_membership_commitments.sql and existing personal
-- membership tier/history tables. Additive only: never changes a purchase,
-- membership override, billing agreement, invoice, payment or entitlement.
BEGIN;

CREATE TABLE IF NOT EXISTS public.member_membership_amendment (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenant(id),
  member_id uuid NOT NULL REFERENCES public.member(id),
  source_record_id uuid NOT NULL REFERENCES public.member_membership_history(id),
  actor_id uuid NOT NULL,
  idempotency_key text NOT NULL CHECK (idempotency_key ~ '^[A-Za-z0-9_.:-]{8,128}$'),
  request jsonb NOT NULL CHECK (jsonb_typeof(request) = 'object'),
  quote jsonb NOT NULL CHECK (jsonb_typeof(quote) = 'object' AND quote->>'version' = '1'),
  status text NOT NULL CHECK (status IN ('pending_settlement', 'pending_application')),
  settlement_status text NOT NULL DEFAULT 'not_started' CHECK (settlement_status = 'not_started'),
  entitlement_applied boolean NOT NULL DEFAULT false CHECK (entitlement_applied = false),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, member_id, idempotency_key),
  -- No cancellation/replacement lifecycle exists yet. Block multiple open
  -- proposals instead of letting an operator accidentally double-settle later.
  UNIQUE (tenant_id, source_record_id)
);
CREATE INDEX IF NOT EXISTS member_membership_amendment_history_idx
  ON public.member_membership_amendment (tenant_id, member_id, created_at DESC);
ALTER TABLE public.member_membership_amendment ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.member_membership_amendment FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.member_membership_amendment TO service_role;

CREATE OR REPLACE FUNCTION public.reject_member_amendment_mutation()
RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  RAISE EXCEPTION 'Membership amendment records are immutable; future lifecycle changes require append-only settlement/application events';
END;
$$;
DROP TRIGGER IF EXISTS member_amendment_immutable ON public.member_membership_amendment;
CREATE TRIGGER member_amendment_immutable BEFORE UPDATE OR DELETE
  ON public.member_membership_amendment FOR EACH ROW
  EXECUTE FUNCTION public.reject_member_amendment_mutation();

CREATE OR REPLACE FUNCTION public.propose_member_membership_amendment(
  p_tenant_id uuid, p_member_id uuid, p_actor_id uuid,
  p_idempotency_key text, p_request jsonb, p_quote jsonb
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  existing public.member_membership_amendment;
  source public.member_membership_history;
  target public.membership_tier_config;
  band_snapshot jsonb;
  vat_snapshot jsonb;
  saved public.member_membership_amendment;
  today date := (clock_timestamp() AT TIME ZONE 'UTC')::date;
  expected_status text;
BEGIN
  IF p_actor_id IS NULL OR p_request->>'memberId' IS DISTINCT FROM p_member_id::text
      OR p_request->>'settlementChoice' IS DISTINCT FROM 'defer'
      OR COALESCE(p_request->>'expectedQuote', '') !~ '^[a-f0-9]{64}$'
      OR length(btrim(COALESCE(p_request->>'reason', ''))) NOT BETWEEN 1 AND 2000
      OR p_idempotency_key IS NULL OR p_idempotency_key !~ '^[A-Za-z0-9_.:-]{8,128}$' THEN
    RAISE EXCEPTION 'Invalid tracked amendment request' USING ERRCODE = '22023';
  END IF;
  -- Serialize idempotency and all proposals for this tenant/member.
  PERFORM 1 FROM public.member WHERE id = p_member_id AND tenant_id = p_tenant_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Member not found in tenant' USING ERRCODE = '40001'; END IF;
  SELECT * INTO existing FROM public.member_membership_amendment
    WHERE tenant_id = p_tenant_id AND member_id = p_member_id AND idempotency_key = p_idempotency_key;
  IF FOUND THEN
    IF existing.request IS DISTINCT FROM p_request THEN
      RAISE EXCEPTION 'Idempotency key belongs to a different request' USING ERRCODE = '40001';
    END IF;
    RETURN jsonb_build_object('amendment', to_jsonb(existing), 'replayed', true);
  END IF;
  IF p_request->>'effectiveDate' IS DISTINCT FROM today::text
      OR p_quote->>'effectiveDate' IS DISTINCT FROM today::text
      OR p_quote->>'version' IS DISTINCT FROM '1' THEN
    RAISE EXCEPTION 'Quote is stale or unsupported; preview again' USING ERRCODE = '40001';
  END IF;
  SELECT * INTO source FROM public.member_membership_history
    WHERE id = (p_quote->>'sourceRecordId')::uuid AND tenant_id = p_tenant_id
      AND member_id = p_member_id FOR UPDATE;
  IF NOT FOUND OR to_jsonb(source) IS DISTINCT FROM p_quote->'sourceSnapshot'
      OR source.status IS DISTINCT FROM 'active' OR source.payment_status IS DISTINCT FROM 'paid'
      OR source.term_start_date IS NULL OR source.membership_renewal_date IS NULL
      OR source.term_start_date > today OR source.membership_renewal_date <= today
      OR source.term_key IS NULL OR source.commitment_snapshot IS NULL
      OR source.billing_agreement_id IS NOT NULL
      OR source.commitment_snapshot->>'payment_frequency' IS DISTINCT FROM 'upfront' THEN
    RAISE EXCEPTION 'Original purchase changed or is not eligible; preview again' USING ERRCODE = '40001';
  END IF;
  IF (SELECT count(*) FROM public.member_membership_history
      WHERE tenant_id = p_tenant_id AND member_id = p_member_id AND status = 'active'
        AND term_start_date <= today
        AND (membership_renewal_date > today OR (membership_renewal_date IS NULL AND term_end_date >= today))) <> 1 THEN
    RAISE EXCEPTION 'Ambiguous current purchase requires review' USING ERRCODE = '40001';
  END IF;
  SELECT * INTO target FROM public.membership_tier_config
    WHERE id = (p_request->>'configId')::uuid AND tenant_id = p_tenant_id FOR SHARE;
  IF NOT FOUND OR to_jsonb(target) IS DISTINCT FROM p_quote->'targetSnapshot'->'config'
      OR target.structure_scope_type IS DISTINCT FROM 'member' OR target.is_active IS DISTINCT FROM true
      OR target.billing_period IS DISTINCT FROM 'annual' OR target.currency IS DISTINCT FROM source.currency
      OR target.effective_from IS NULL OR target.effective_from > today
      OR (target.effective_to IS NOT NULL AND target.effective_to < today) THEN
    RAISE EXCEPTION 'Target structure changed or is not eligible; preview again' USING ERRCODE = '40001';
  END IF;
  IF p_request->>'bandId' IS NOT NULL THEN
    SELECT to_jsonb(b) INTO band_snapshot FROM public.membership_tier_band b
      WHERE b.id = (p_request->>'bandId')::uuid AND b.config_id = target.id AND b.tenant_id = p_tenant_id FOR SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Target band not found' USING ERRCODE = '40001'; END IF;
  ELSE band_snapshot := 'null'::jsonb;
  END IF;
  IF band_snapshot IS DISTINCT FROM p_quote->'targetSnapshot'->'band' THEN
    RAISE EXCEPTION 'Target band changed; preview again' USING ERRCODE = '40001';
  END IF;
  -- Conditional policies are intentionally unsupported, not silently ignored.
  IF EXISTS (SELECT 1 FROM public.membership_tier_discount WHERE tenant_id = p_tenant_id AND config_id = target.id)
      OR EXISTS (SELECT 1 FROM public.membership_tier_vat_override WHERE tenant_id = p_tenant_id AND config_id = target.id) THEN
    RAISE EXCEPTION 'Target pricing policies changed; review required' USING ERRCODE = '40001';
  END IF;
  SELECT to_jsonb(s) INTO vat_snapshot FROM public.system_settings s
    WHERE tenant_id = p_tenant_id AND setting_key = 'xero_vat_rates_' || p_tenant_id::text FOR SHARE;
  IF COALESCE(vat_snapshot, 'null'::jsonb) IS DISTINCT FROM p_quote->'targetSnapshot'->'vatSetting' THEN
    RAISE EXCEPTION 'Saved tax rates changed; preview again' USING ERRCODE = '40001';
  END IF;
  expected_status := CASE WHEN (p_quote->'delta'->>'netMinor')::bigint = 0
      AND (p_quote->'delta'->>'vatMinor')::bigint = 0 THEN 'pending_application' ELSE 'pending_settlement' END;
  IF p_quote->>'status' IS DISTINCT FROM expected_status
      OR p_quote->>'settlementStatus' IS DISTINCT FROM 'not_started'
      OR p_quote->>'entitlementApplied' IS DISTINCT FROM 'false' THEN
    RAISE EXCEPTION 'Unsupported application or settlement claim' USING ERRCODE = '22023';
  END IF;
  INSERT INTO public.member_membership_amendment
    (tenant_id, member_id, source_record_id, actor_id, idempotency_key, request, quote, status)
    VALUES (p_tenant_id, p_member_id, source.id, p_actor_id, p_idempotency_key, p_request, p_quote, expected_status)
    RETURNING * INTO saved;
  RETURN jsonb_build_object('amendment', to_jsonb(saved), 'replayed', false);
END;
$$;
REVOKE ALL ON FUNCTION public.propose_member_membership_amendment(uuid, uuid, uuid, text, jsonb, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.propose_member_membership_amendment(uuid, uuid, uuid, text, jsonb, jsonb) TO service_role;
REVOKE ALL ON FUNCTION public.reject_member_amendment_mutation() FROM PUBLIC, anon, authenticated;
COMMIT;
