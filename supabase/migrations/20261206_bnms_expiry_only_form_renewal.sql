BEGIN;

-- Narrow admission for the reviewed import shape + immutable operator policy.
-- This installs capability only: no rollout, history or financial data writes.
CREATE FUNCTION public.form_expiry_only_renewal_policy(h jsonb, tenant uuid, member uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE a public.membership_expiry_policy_assignment%ROWTYPE;
  c public.membership_tier_config%ROWTYPE;
  n jsonb;
BEGIN
  IF tenant IS DISTINCT FROM 'ff2df806-b321-4254-b651-3af11fccf1db'::uuid OR member IS NULL
    OR h->>'tenant_id' IS DISTINCT FROM tenant::text OR h->>'member_id' IS DISTINCT FROM member::text
    OR h->>'organization_id' IS NOT NULL OR h->>'membership_year' IS DISTINCT FROM '2025/2026'
    OR h->>'status' IS DISTINCT FROM 'active' OR h->>'payment_status' IS DISTINCT FROM 'paid'
    OR h->>'payment_method' IS DISTINCT FROM 'upfront' OR h->>'billing_period' IS DISTINCT FROM 'annual'
    OR h->>'currency' IS DISTINCT FROM 'GBP' OR coalesce(h->>'tier_label','')=''
    OR h->>'term_start_date' IS NOT NULL OR h->>'config_id' IS NOT NULL
    OR h->>'membership_renewal_date' IS NOT NULL OR h->>'term_key' IS NOT NULL
    OR h->>'term_duration_months' IS NOT NULL OR h->>'term_anchor_date' IS NOT NULL
    OR h->>'previous_term_id' IS NOT NULL OR h->>'commitment_snapshot' IS NOT NULL
    OR h->>'billing_agreement_id' IS NOT NULL OR h->>'term_end_date' IS NULL
    OR (h->>'term_end_date')::date > DATE '2026-12-31'
    OR ((h->>'final_cost' IS NULL) <> (h->>'total_with_vat' IS NULL))
    OR (h->>'final_cost' IS NOT NULL AND ((h->>'final_cost')::numeric < 0
      OR (h->>'final_cost')::numeric IS DISTINCT FROM (h->>'total_with_vat')::numeric))
    THEN RETURN NULL; END IF;
  n := (h->>'notes')::jsonb;
  IF n->>'source' IS DISTINCT FROM 'bnms_non_dd_current_backfill'
    OR n->'version' IS DISTINCT FROM '1'::jsonb
    OR coalesce(n->>'sourceHash','') !~ '^[a-f0-9]{64}$'
    OR n->>'paymentAuthority' IS DISTINCT FROM 'operator_attested_upfront_paid_2025_2026'
    OR n->>'startDateAuthority' IS DISTINCT FROM 'unknown_not_inferred'
    OR n->>'expiryAuthority' IS DISTINCT FROM 'retained_legacy_expiry'
    OR coalesce(n->>'termAuthority','') NOT IN
      ('operator_attested_existing_2025_2026','operator_reviewed_pilot','explicit_invoice_2025_2026')
    THEN RETURN NULL; END IF;
  SELECT * INTO a FROM public.membership_expiry_policy_assignment
    WHERE tenant_id=tenant AND member_id=member AND history_id=(h->>'id')::uuid
      AND expiry_date=(h->>'term_end_date')::date AND approval_source='operator';
  IF NOT FOUND OR a.policy_snapshot IS DISTINCT FROM
    '{"renewal_open_days":90,"renewal_grace_days":90,"renewal_disable_login":true,
      "renewal_change_role":false,"renewal_fallback_role_id":null}'::jsonb THEN RETURN NULL; END IF;
  SELECT * INTO c FROM public.membership_tier_config WHERE id=a.config_id AND tenant_id=tenant;
  IF NOT FOUND OR c.is_active IS DISTINCT FROM true OR c.structure_scope_type IS DISTINCT FROM 'member'
    OR c.billing_period IS DISTINCT FROM 'annual'
    OR c.effective_from::date > a.expiry_date+1 OR c.effective_to::date < a.expiry_date+1
    THEN RETURN NULL; END IF;
  RETURN a.policy_snapshot || jsonb_build_object('assigned_config_id',a.config_id);
EXCEPTION WHEN invalid_text_representation OR datetime_field_overflow THEN RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public.form_expiry_only_renewal_policy(jsonb,uuid,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.form_expiry_only_renewal_policy(jsonb,uuid,uuid) TO service_role;

-- Preserve all installed locking, quote/attempt recovery, cross-provider and
-- tenant-rollout guards. Refuse an unexpected installed function contract.
DO $migration$
DECLARE definition text;
  old_check text := 'IF prior IS NULL OR prior->>''term_start_date'' IS NULL';
  old_policy text := 'policy := coalesce(prior->''renewal_policy_snapshot'',prior#>''{commitment_snapshot,config}'',prior#>''{incentive_snapshot,config}'');';
BEGIN
  SELECT pg_get_functiondef('public.reserve_membership_successor(uuid,uuid,uuid,uuid,date,date,text,text,jsonb)'::regprocedure)
    INTO definition;
  IF position(old_check IN definition)=0 OR position(old_policy IN definition)=0
    OR position('IF NOT public.membership_successor_elections_enabled(p_tenant_id) THEN' IN definition)=0
    THEN RAISE EXCEPTION 'Unexpected reservation contract; expiry-only migration requires review'; END IF;
  definition := replace(definition, old_check, $replacement$
  IF prior->>'term_start_date' IS NULL AND prior IS NOT NULL THEN
    policy := public.form_expiry_only_renewal_policy(prior,p_tenant_id,p_member_id);
    IF p_origin <> 'form' OR p_organization_id IS NOT NULL OR policy IS NULL
      OR p_quote#>>'{simulation,config,id}' IS DISTINCT FROM policy->>'assigned_config_id'
      OR p_end IS DISTINCT FROM ((p_start + interval '1 year')::date - 1)
      OR EXISTS (SELECT FROM public.member_membership_history h
        WHERE h.tenant_id=p_tenant_id AND h.member_id=p_member_id AND h.id<>p_previous_term_id
          AND coalesce(h.status,'') NOT IN ('cancelled','canceled','void','expired_checkout')
          AND (h.term_start_date IS NULL OR h.term_start_date <= (prior->>'term_end_date')::date))
      OR EXISTS (SELECT FROM public.membership_billing_agreements b
        WHERE b.tenant_id=p_tenant_id AND b.member_id=p_member_id
          AND coalesce(b.status,'') NOT IN ('cancelled','canceled','void','expired_checkout','completed','expired')
          AND b.term_start_date IS DISTINCT FROM p_start)
      THEN RAISE EXCEPTION 'Expiry-only predecessor requires assigned renewal authority without conflicting obligations'; END IF;
  END IF;
  IF prior IS NULL OR (prior->>'term_start_date' IS NULL AND policy IS NULL)
  $replacement$);
  definition := replace(definition, old_policy,
    'policy := coalesce(policy, coalesce(prior->''renewal_policy_snapshot'',prior#>''{commitment_snapshot,config}'',prior#>''{incentive_snapshot,config}''));');
  EXECUTE definition;
END $migration$;

CREATE FUNCTION public.form_expiry_only_renewal_supported()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$ SELECT true $$;
REVOKE ALL ON FUNCTION public.form_expiry_only_renewal_supported() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.form_expiry_only_renewal_supported() TO service_role;
COMMIT;