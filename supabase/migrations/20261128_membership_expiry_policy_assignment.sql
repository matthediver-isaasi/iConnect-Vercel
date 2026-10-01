BEGIN;

-- Operator authority for reviewed expiry-only imports, never a purchased term.
CREATE TABLE public.membership_expiry_policy_assignment (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenant(id),
  history_id uuid NOT NULL UNIQUE REFERENCES public.member_membership_history(id),
  member_id uuid NOT NULL REFERENCES public.member(id),
  config_id uuid NOT NULL REFERENCES public.membership_tier_config(id),
  config_name text NOT NULL CHECK (length(trim(config_name)) > 0),
  expiry_date date NOT NULL,
  policy_snapshot jsonb NOT NULL CHECK (policy_snapshot = '{
    "renewal_open_days":90,"renewal_grace_days":90,"renewal_disable_login":true,
    "renewal_change_role":false,"renewal_fallback_role_id":null
  }'::jsonb),
  approval_source text NOT NULL CHECK (approval_source = 'operator'),
  approval_reference text NOT NULL CHECK (length(trim(approval_reference)) > 0),
  approved_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.membership_expiry_policy_assignment ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.membership_expiry_policy_assignment FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT ON public.membership_expiry_policy_assignment TO service_role;

CREATE FUNCTION public.guard_membership_expiry_policy_assignment()
RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE h public.member_membership_history%ROWTYPE;
  c public.membership_tier_config%ROWTYPE;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'Operator expiry policy assignments are immutable';
  END IF;
  SELECT * INTO h FROM public.member_membership_history WHERE id=NEW.history_id FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Expiry policy history not found'; END IF;
  IF NEW.tenant_id <> 'ff2df806-b321-4254-b651-3af11fccf1db'::uuid
    OR h.tenant_id IS DISTINCT FROM NEW.tenant_id OR h.member_id IS DISTINCT FROM NEW.member_id
    OR h.term_end_date IS DISTINCT FROM NEW.expiry_date
    OR h.membership_year IS DISTINCT FROM '2025/2026' OR h.status IS DISTINCT FROM 'active'
    OR h.payment_status IS DISTINCT FROM 'paid' OR h.payment_method IS DISTINCT FROM 'upfront'
    OR h.billing_period IS DISTINCT FROM 'annual' OR h.currency IS DISTINCT FROM 'GBP'
    OR h.tier_label IS NULL OR h.config_id IS NOT NULL OR h.term_start_date IS NOT NULL
    OR h.membership_renewal_date IS NOT NULL OR h.term_key IS NOT NULL OR h.term_duration_months IS NOT NULL
    OR h.term_anchor_date IS NOT NULL OR h.previous_term_id IS NOT NULL
    OR h.commitment_snapshot IS NOT NULL OR h.billing_agreement_id IS NOT NULL
    OR h.expiry_enforced_at IS NOT NULL OR h.term_end_date > DATE '2026-12-31'
    OR (h.notes::jsonb->>'source') IS DISTINCT FROM 'bnms_non_dd_current_backfill'
    OR ((h.final_cost IS NULL) <> (h.total_with_vat IS NULL))
    OR (h.final_cost IS NOT NULL AND (h.final_cost < 0 OR h.final_cost IS DISTINCT FROM h.total_with_vat))
    OR NOT EXISTS (SELECT FROM public.member m WHERE m.id=NEW.member_id AND m.tenant_id=NEW.tenant_id)
    THEN RAISE EXCEPTION 'Expiry policy history/owner binding is invalid'; END IF;
  SELECT * INTO c FROM public.membership_tier_config WHERE id=NEW.config_id FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Expiry policy configuration not found'; END IF;
  IF c.tenant_id IS DISTINCT FROM NEW.tenant_id OR c.structure_scope_type IS DISTINCT FROM 'member'
    OR c.billing_period IS DISTINCT FROM 'annual' OR c.name IS DISTINCT FROM NEW.config_name
    OR c.is_active IS DISTINCT FROM true
    OR c.effective_from::date > NEW.expiry_date+1 OR c.effective_to::date < NEW.expiry_date+1
    OR NEW.policy_snapshot IS DISTINCT FROM jsonb_build_object(
      'renewal_open_days',c.renewal_open_days,'renewal_grace_days',c.renewal_grace_days,
      'renewal_disable_login',c.renewal_disable_login,'renewal_change_role',c.renewal_change_role,
      'renewal_fallback_role_id',c.renewal_fallback_role_id)
    THEN RAISE EXCEPTION 'Expiry policy configuration/snapshot is invalid'; END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.guard_membership_expiry_policy_assignment() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.guard_membership_expiry_policy_assignment() TO service_role;
CREATE TRIGGER membership_expiry_policy_assignment_guard
BEFORE INSERT OR UPDATE OR DELETE ON public.membership_expiry_policy_assignment
FOR EACH ROW EXECUTE FUNCTION public.guard_membership_expiry_policy_assignment();

COMMIT;