-- Preparatory storage only. No existing rows, roles, policies or checkout
-- functions are modified. Rollout and writes are deliberately not enabled.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

CREATE TABLE public.membership_payment_grace_exit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenant(id),
  member_id uuid NOT NULL REFERENCES public.member(id),
  history_id uuid NOT NULL REFERENCES public.member_membership_history(id),
  agreement_id uuid NOT NULL REFERENCES public.membership_billing_agreements(id),
  plan_id uuid NOT NULL REFERENCES public.membership_payment_plans(id),
  config_id uuid NOT NULL REFERENCES public.membership_tier_config(id),
  role_action_id uuid NOT NULL REFERENCES public.membership_arrears_role_action(id),
  fallback_role_id uuid NOT NULL REFERENCES public.role(id),
  failed_payment_id text NOT NULL CHECK (length(trim(failed_payment_id)) > 0),
  grace_expires_at timestamptz NOT NULL,
  effective_at timestamptz NOT NULL DEFAULT now(),
  original_term_start_date date NOT NULL,
  original_term_end_date date NOT NULL,
  original_payment_status text NOT NULL,
  approval_reference text NOT NULL CHECK (length(trim(approval_reference)) > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, history_id),
  UNIQUE (tenant_id, plan_id),
  CHECK (original_term_start_date <= original_term_end_date),
  CHECK (effective_at >= grace_expires_at),
  CHECK (original_payment_status IN ('unpaid','partial','partially_paid'))
);

COMMENT ON TABLE public.membership_payment_grace_exit IS
  'Immutable evidence ending entitlement after failed-payment grace. Never settlement, debt forgiveness, a rewrite of original term dates, or authority to collect.';

CREATE TABLE public.membership_payment_grace_exit_release (
  tenant_id uuid PRIMARY KEY REFERENCES public.tenant(id),
  enabled boolean NOT NULL DEFAULT false,
  approval_reference text NOT NULL CHECK (length(trim(approval_reference)) > 0),
  enabled_at timestamptz,
  CHECK (NOT enabled OR enabled_at IS NOT NULL)
);

ALTER TABLE public.membership_payment_grace_exit ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.membership_payment_grace_exit_release ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.membership_payment_grace_exit,
  public.membership_payment_grace_exit_release FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.membership_payment_grace_exit,
  public.membership_payment_grace_exit_release TO service_role;

-- Defence in depth: even a future privileged writer cannot create loosely
-- bound evidence. There is intentionally NO writable service-role RPC yet.
CREATE FUNCTION public.guard_membership_payment_grace_exit() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  h public.member_membership_history%ROWTYPE;
  a public.membership_billing_agreements%ROWTYPE;
  p public.membership_payment_plans%ROWTYPE;
  c public.membership_tier_config%ROWTYPE;
  r public.membership_arrears_role_action%ROWTYPE;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'Payment grace expiry evidence is immutable';
  END IF;
  IF NOT EXISTS (SELECT FROM public.membership_payment_grace_exit_release
    WHERE tenant_id=NEW.tenant_id AND enabled) THEN
    RAISE EXCEPTION 'Payment grace expiry rollout is disabled';
  END IF;
  SELECT * INTO p FROM public.membership_payment_plans
    WHERE id=NEW.plan_id AND tenant_id=NEW.tenant_id FOR UPDATE;
  SELECT * INTO h FROM public.member_membership_history
    WHERE id=NEW.history_id AND tenant_id=NEW.tenant_id FOR UPDATE;
  SELECT * INTO a FROM public.membership_billing_agreements
    WHERE id=NEW.agreement_id AND tenant_id=NEW.tenant_id FOR UPDATE;
  SELECT * INTO c FROM public.membership_tier_config
    WHERE id=NEW.config_id AND tenant_id=NEW.tenant_id FOR SHARE;
  SELECT * INTO r FROM public.membership_arrears_role_action
    WHERE id=NEW.role_action_id AND tenant_id=NEW.tenant_id FOR SHARE;
  IF p.id IS NULL OR h.id IS NULL OR a.id IS NULL OR c.id IS NULL OR r.id IS NULL
    OR h.member_id IS DISTINCT FROM NEW.member_id
    OR p.member_id IS DISTINCT FROM NEW.member_id
    OR a.member_id IS DISTINCT FROM NEW.member_id
    OR p.organization_id IS NOT NULL OR a.organization_id IS NOT NULL
    OR p.billing_agreement_id IS DISTINCT FROM a.id
    OR h.billing_agreement_id IS DISTINCT FROM a.id
    OR h.config_id IS DISTINCT FROM c.id
    OR a.metadata#>>'{dd,config_id}' IS DISTINCT FROM c.id::text
    OR p.provider IS DISTINCT FROM 'gocardless' OR a.provider IS DISTINCT FROM 'gocardless'
    OR p.environment IS DISTINCT FROM a.environment
    OR p.environment IS NULL OR p.environment NOT IN ('live','sandbox')
    OR p.gocardless_mandate_id IS DISTINCT FROM a.gocardless_mandate_id
    OR p.gocardless_mandate_id IS NULL
    OR p.status IS NULL OR p.status NOT IN ('payment_plan_cancelled','cancelled','canceled')
    OR a.status IS NULL OR a.status NOT IN ('payment_plan_cancelled','cancelled','canceled')
    OR h.cancelled_for_switch_at IS NOT NULL OR a.cancelled_for_switch_at IS NOT NULL
    OR h.payment_status IS NULL OR h.payment_status NOT IN ('unpaid','partial','partially_paid')
    OR h.status IS NULL OR h.status IN ('cancelled','canceled','void','expired_checkout','replaced','cancelled_by_request')
    OR h.term_start_date IS DISTINCT FROM NEW.original_term_start_date
    OR h.term_end_date IS DISTINCT FROM NEW.original_term_end_date
    OR h.payment_status IS DISTINCT FROM NEW.original_payment_status
    OR p.grace_expires_at IS DISTINCT FROM NEW.grace_expires_at
    OR p.grace_expires_at IS NULL OR p.grace_expires_at > now()
    OR NEW.effective_at > now() OR NEW.effective_at < p.grace_expires_at
    OR p.last_payment_status IS DISTINCT FROM 'failed'
    OR p.last_payment_id IS DISTINCT FROM NEW.failed_payment_id
    OR p.auto_retry_claim_token IS NOT NULL
    OR c.renewal_fallback_role_id IS DISTINCT FROM NEW.fallback_role_id
    OR r.plan_id IS DISTINCT FROM p.id OR r.member_id IS DISTINCT FROM NEW.member_id
    OR r.config_id IS DISTINCT FROM c.id OR r.assigned_role_id IS DISTINCT FROM NEW.fallback_role_id
    OR r.restored_at IS NOT NULL THEN
    RAISE EXCEPTION 'Payment grace expiry evidence does not match the membership, failure or role action';
  END IF;
  IF NOT EXISTS (SELECT FROM public.member m JOIN public.role role
    ON role.id=m.role_id AND role.tenant_id=m.tenant_id
    WHERE m.id=NEW.member_id AND m.tenant_id=NEW.tenant_id
      AND m.role_id=NEW.fallback_role_id AND role.is_tenant_admin IS NOT TRUE)
    OR NOT EXISTS (SELECT FROM public.gocardless_mandates m
      WHERE m.tenant_id=NEW.tenant_id AND m.environment=p.environment
        AND m.gocardless_mandate_id=p.gocardless_mandate_id AND m.status='cancelled')
    OR NOT EXISTS (SELECT FROM public.gocardless_payments pay
      WHERE pay.tenant_id=NEW.tenant_id AND pay.plan_id=p.id
        AND pay.environment=p.environment AND pay.gocardless_mandate_id=p.gocardless_mandate_id
        AND pay.gocardless_payment_id=NEW.failed_payment_id AND pay.status='failed')
    OR EXISTS (SELECT FROM public.gocardless_payments pay
      WHERE pay.tenant_id=NEW.tenant_id AND pay.plan_id=p.id
        AND (pay.status IS NULL OR pay.status NOT IN
          ('failed','cancelled','customer_approval_denied','paid_out','confirmed')))
    OR EXISTS (SELECT FROM public.membership_successor_election e
      WHERE e.tenant_id=NEW.tenant_id AND e.member_id=NEW.member_id AND e.status<>'released')
    OR EXISTS (SELECT FROM public.member_membership_history other
      WHERE other.tenant_id=NEW.tenant_id AND other.member_id=NEW.member_id AND other.id<>h.id
        AND coalesce(other.status,'') NOT IN ('cancelled','canceled','void','expired_checkout','replaced','cancelled_by_request')
        AND (other.term_end_date IS NULL OR other.term_end_date >= (NEW.effective_at AT TIME ZONE 'UTC')::date))
    OR EXISTS (SELECT FROM public.membership_billing_agreements other
      WHERE other.tenant_id=NEW.tenant_id AND other.member_id=NEW.member_id AND other.id<>a.id
        AND (other.status IS NULL OR other.status NOT IN
          ('payment_plan_cancelled','cancelled','canceled','completed','expired'))) THEN
    RAISE EXCEPTION 'Payment grace expiry has conflicting or incomplete payment/access evidence';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.guard_membership_payment_grace_exit()
  FROM PUBLIC, anon, authenticated, service_role;
CREATE TRIGGER guard_membership_payment_grace_exit
  BEFORE INSERT OR UPDATE OR DELETE ON public.membership_payment_grace_exit
  FOR EACH ROW EXECUTE FUNCTION public.guard_membership_payment_grace_exit();
COMMIT;
