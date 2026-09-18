-- Additive only: no existing agreement, consent, price or collection changes.
ALTER TABLE public.membership_tier_config
  ADD COLUMN IF NOT EXISTS dd_policy_version integer,
  ADD COLUMN IF NOT EXISTS dd_collection_end_policy text,
  ADD COLUMN IF NOT EXISTS dd_pricing_policy text;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'membership_tier_dd_explicit_policy') THEN
    ALTER TABLE public.membership_tier_config ADD CONSTRAINT membership_tier_dd_explicit_policy CHECK (
      (dd_policy_version IS NULL AND dd_collection_end_policy IS NULL AND dd_pricing_policy IS NULL)
      OR (dd_policy_version IS NOT NULL AND dd_policy_version = 1 AND dd_collection_end_policy IS NOT NULL AND dd_collection_end_policy IN ('stop','continue')
        AND dd_pricing_policy IS NOT NULL AND dd_pricing_policy IN ('fixed','dynamic')
        AND (dd_pricing_policy <> 'dynamic' OR dd_invoicing_mode IS NOT DISTINCT FROM 'per_instalment'))
    );
  END IF;
END $$;
ALTER TABLE public.membership_payment_plans
  ADD COLUMN IF NOT EXISTS dynamic_next_collection_date date,
  ADD COLUMN IF NOT EXISTS dynamic_next_check_at timestamptz,
  ADD COLUMN IF NOT EXISTS dynamic_collection_error text;

CREATE TABLE IF NOT EXISTS public.gocardless_collection_reservations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenant(id),
  billing_agreement_id uuid NOT NULL REFERENCES public.membership_billing_agreements(id),
  plan_id uuid NOT NULL REFERENCES public.membership_payment_plans(id),
  term_key text NOT NULL,
  collection_number integer NOT NULL CHECK (collection_number > 0),
  due_date date NOT NULL,
  requested_charge_date date NOT NULL,
  amount_minor integer NOT NULL CHECK (amount_minor > 0),
  currency text NOT NULL,
  status text NOT NULL DEFAULT 'reserved' CHECK (status IN ('reserved','submitted','blocked')),
  gocardless_payment_id text,
  price_snapshot jsonb NOT NULL,
  provider_evidence jsonb NOT NULL,
  provider_charge_date date,
  blocked_reason text,
  idempotency_key text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(plan_id, collection_number),
  UNIQUE(plan_id, due_date),
  UNIQUE(gocardless_payment_id)
);
ALTER TABLE public.gocardless_collection_reservations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.gocardless_collection_reservations FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON public.gocardless_collection_reservations TO service_role;
CREATE INDEX IF NOT EXISTS gocardless_collection_reservation_agreement_idx
  ON public.gocardless_collection_reservations(tenant_id,billing_agreement_id,due_date);
CREATE INDEX IF NOT EXISTS membership_dynamic_collection_due_idx
  ON public.membership_payment_plans(dynamic_next_collection_date)
  WHERE dynamic_next_collection_date IS NOT NULL;

CREATE OR REPLACE FUNCTION public.guard_gocardless_dynamic_reservation()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Collection reservations cannot be deleted'; END IF;
  IF (to_jsonb(NEW) - ARRAY['status','gocardless_payment_id','provider_evidence','provider_charge_date','blocked_reason','updated_at'])
    IS DISTINCT FROM
    (to_jsonb(OLD) - ARRAY['status','gocardless_payment_id','provider_evidence','provider_charge_date','blocked_reason','updated_at']) THEN
    RAISE EXCEPTION 'Collection request evidence is immutable';
  END IF;
  IF OLD.gocardless_payment_id IS NOT NULL AND
    (NEW.gocardless_payment_id IS DISTINCT FROM OLD.gocardless_payment_id
      OR NEW.provider_charge_date IS DISTINCT FROM OLD.provider_charge_date) THEN
    RAISE EXCEPTION 'Collection provider identity is immutable';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS guard_gocardless_dynamic_reservation ON public.gocardless_collection_reservations;
CREATE TRIGGER guard_gocardless_dynamic_reservation BEFORE UPDATE OR DELETE
  ON public.gocardless_collection_reservations FOR EACH ROW
  EXECUTE FUNCTION public.guard_gocardless_dynamic_reservation();

CREATE OR REPLACE FUNCTION public.guard_dd_collection_policy_snapshot()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF OLD.metadata->'dd'->'collection_policy' IS DISTINCT FROM NEW.metadata->'dd'->'collection_policy'
    OR OLD.commitment_snapshot->'collection_policy' IS DISTINCT FROM NEW.commitment_snapshot->'collection_policy' THEN
    RAISE EXCEPTION 'Purchased Direct Debit collection policy is immutable';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS guard_dd_collection_policy_snapshot ON public.membership_billing_agreements;
CREATE TRIGGER guard_dd_collection_policy_snapshot BEFORE UPDATE ON public.membership_billing_agreements
  FOR EACH ROW EXECUTE FUNCTION public.guard_dd_collection_policy_snapshot();

CREATE OR REPLACE FUNCTION public.reserve_gocardless_dynamic_collection(
  p_tenant_id uuid, p_plan_id uuid, p_collection_number integer, p_due_date date,
  p_price_snapshot jsonb, p_provider_evidence jsonb, p_idempotency_key text
) RETURNS public.gocardless_collection_reservations
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  p public.membership_payment_plans;
  a public.membership_billing_agreements;
  r public.gocardless_collection_reservations;
  terms jsonb;
  owner_row jsonb;
BEGIN
  SELECT * INTO p FROM public.membership_payment_plans WHERE id=p_plan_id AND tenant_id=p_tenant_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Payment plan not found in tenant'; END IF;
  SELECT * INTO a FROM public.membership_billing_agreements
    WHERE id=p.billing_agreement_id AND tenant_id=p_tenant_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Billing agreement not found in tenant'; END IF;
  terms := a.metadata->'dd';
  IF a.member_id IS NOT NULL THEN
    SELECT to_jsonb(m) INTO owner_row FROM public.member m
      WHERE id=a.member_id AND tenant_id=p_tenant_id FOR UPDATE;
  ELSE
    SELECT to_jsonb(o) INTO owner_row FROM public.organization o
      WHERE id=a.organization_id AND tenant_id=p_tenant_id FOR UPDATE;
  END IF;
  IF owner_row IS NULL OR COALESCE((owner_row->>'membership_paused')::boolean,false)
    OR owner_row->>'status' IN ('cancelled','deleted','paused') THEN
    RAISE EXCEPTION 'Dynamic collection owner is missing, paused or cancelled';
  END IF;
  IF terms->'collection_policy'->>'version' IS DISTINCT FROM '1'
    OR terms->'collection_policy'->>'pricing_policy' IS DISTINCT FROM 'dynamic'
    OR terms->>'invoicing_mode' IS DISTINCT FROM 'per_instalment'
    OR p.metadata->>'collection_mode' IS DISTINCT FROM 'dynamic'
    OR p.gocardless_subscription_id IS NOT NULL
    OR a.gocardless_mandate_id IS NULL
    OR p.gocardless_mandate_id IS DISTINCT FROM a.gocardless_mandate_id
    OR a.status NOT IN ('active','mandate_pending','first_payment_pending')
    OR p.status NOT IN ('active','mandate_pending','first_payment_pending')
    OR p.collection_stopped_at IS NOT NULL
    OR terms->>'arrears_state' IS NOT NULL
    OR EXISTS(SELECT 1 FROM public.membership_monthly_arrears_period
      WHERE tenant_id=p_tenant_id AND plan_id=p.id AND settled_at IS NULL) THEN
    RAISE EXCEPTION 'Dynamic collection is not authorized by current consent/lifecycle';
  END IF;
  SELECT * INTO r FROM public.gocardless_collection_reservations
    WHERE plan_id=p.id AND collection_number=p_collection_number;
  IF FOUND THEN RETURN r; END IF;
  IF p_collection_number <> 1 + (SELECT count(*) FROM public.gocardless_collection_reservations WHERE plan_id=p.id)
    OR p_collection_number > (terms->>'instalment_count')::integer
    OR p_due_date < (terms->'commitment'->>'term_start_date')::date
    OR p_due_date > (terms->'commitment'->>'term_end_date')::date
    OR p_due_date IS DISTINCT FROM p.dynamic_next_collection_date
    OR p_due_date IS DISTINCT FROM
      ((p.metadata->>'dynamic_first_date')::date + make_interval(months => p_collection_number - 1))::date
    OR EXISTS(SELECT 1 FROM public.gocardless_collection_reservations
      WHERE plan_id=p.id AND status <> 'submitted')
    OR terms->'commitment'->>'term_key' IS NULL
    OR p_price_snapshot->>'currency' IS DISTINCT FROM terms->>'currency'
    OR p_price_snapshot->>'intended_date' IS DISTINCT FROM p_due_date::text
    OR (p_provider_evidence->>'next_possible_charge_date')::date < p_due_date
    OR (p_provider_evidence->>'next_possible_charge_date')::date > (terms->'commitment'->>'term_end_date')::date
    OR p_provider_evidence->>'next_possible_charge_date' IS NULL
    OR NOT EXISTS(SELECT 1 FROM public.membership_tier_config
      WHERE id=(p_price_snapshot->>'config_id')::uuid AND tenant_id=p_tenant_id) THEN
    RAISE EXCEPTION 'Dynamic collection request does not match its purchased term';
  END IF;
  INSERT INTO public.gocardless_collection_reservations(
    tenant_id,billing_agreement_id,plan_id,term_key,collection_number,due_date,requested_charge_date,amount_minor,
    currency,price_snapshot,provider_evidence,idempotency_key
  ) VALUES(p_tenant_id,a.id,p.id,terms->'commitment'->>'term_key',p_collection_number,p_due_date,(p_provider_evidence->>'next_possible_charge_date')::date,
    (p_price_snapshot->>'monthly_amount_minor')::integer,terms->>'currency',
    p_price_snapshot,p_provider_evidence,p_idempotency_key) RETURNING * INTO r;
  RETURN r;
END $$;

CREATE OR REPLACE FUNCTION public.attach_gocardless_dynamic_payment(
  p_tenant_id uuid, p_reservation_id uuid, p_payment jsonb
) RETURNS public.gocardless_collection_reservations
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  r public.gocardless_collection_reservations;
  p public.membership_payment_plans;
  a public.membership_billing_agreements;
  next_due date;
BEGIN
  SELECT * INTO r FROM public.gocardless_collection_reservations
    WHERE id=p_reservation_id AND tenant_id=p_tenant_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Dynamic collection reservation not found'; END IF;
  SELECT * INTO p FROM public.membership_payment_plans WHERE id=r.plan_id AND tenant_id=p_tenant_id;
  SELECT * INTO a FROM public.membership_billing_agreements WHERE id=r.billing_agreement_id AND tenant_id=p_tenant_id;
  IF p_payment->>'id' IS NULL
    OR (p_payment->>'amount')::integer IS DISTINCT FROM r.amount_minor
    OR upper(p_payment->>'currency') IS DISTINCT FROM upper(r.currency)
    OR p_payment->'links'->>'mandate' IS DISTINCT FROM p.gocardless_mandate_id
    OR p_payment->'links'->>'subscription' IS NOT NULL
    OR (p_payment->>'charge_date')::date IS DISTINCT FROM r.requested_charge_date
    OR (r.gocardless_payment_id IS NOT NULL AND r.gocardless_payment_id IS DISTINCT FROM p_payment->>'id') THEN
    RAISE EXCEPTION 'Provider collection evidence does not match reservation';
  END IF;
  UPDATE public.gocardless_collection_reservations SET status='submitted',
    gocardless_payment_id=p_payment->>'id',provider_charge_date=(p_payment->>'charge_date')::date,
    provider_evidence=provider_evidence || jsonb_build_object('status',
      CASE WHEN provider_evidence->>'status' IN ('confirmed','paid_out')
        AND p_payment->>'status' IN ('pending_submission','submitted') THEN provider_evidence->>'status'
        ELSE p_payment->>'status' END,
      'payment_id',p_payment->>'id','charge_date',p_payment->>'charge_date'),
    updated_at=now() WHERE id=r.id RETURNING * INTO r;
  INSERT INTO public.gocardless_payments(tenant_id,plan_id,gocardless_payment_id,gocardless_mandate_id,amount_minor,currency,charge_date,status,updated_at)
    VALUES(p_tenant_id,p.id,p_payment->>'id',p.gocardless_mandate_id,r.amount_minor,r.currency,r.requested_charge_date,p_payment->>'status',now())
    ON CONFLICT(gocardless_payment_id) DO NOTHING;
  IF EXISTS(SELECT 1 FROM public.gocardless_payments WHERE gocardless_payment_id=p_payment->>'id'
    AND (tenant_id IS DISTINCT FROM p_tenant_id OR plan_id IS DISTINCT FROM p.id
      OR amount_minor IS DISTINCT FROM r.amount_minor OR currency IS DISTINCT FROM r.currency)) THEN
    RAISE EXCEPTION 'Payment mirror conflicts with dynamic reservation';
  END IF;
  next_due := ((p.metadata->>'dynamic_first_date')::date + make_interval(months => r.collection_number))::date;
  IF r.collection_number >= (a.metadata->'dd'->>'instalment_count')::integer
    OR next_due > (a.metadata->'dd'->'commitment'->>'term_end_date')::date THEN next_due := NULL; END IF;
  -- Old webhooks must not move the scheduler back to a previous month.
  IF NOT EXISTS(SELECT 1 FROM public.gocardless_collection_reservations WHERE plan_id=p.id AND collection_number>r.collection_number) THEN
    UPDATE public.membership_payment_plans SET amount_minor=r.amount_minor,next_charge_date=r.requested_charge_date,
      dynamic_next_collection_date=next_due,dynamic_collection_error=NULL,updated_at=now() WHERE id=p.id;
  END IF;
  RETURN r;
END $$;
REVOKE ALL ON FUNCTION public.reserve_gocardless_dynamic_collection(uuid,uuid,integer,date,jsonb,jsonb,text) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.attach_gocardless_dynamic_payment(uuid,uuid,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.reserve_gocardless_dynamic_collection(uuid,uuid,integer,date,jsonb,jsonb,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.attach_gocardless_dynamic_payment(uuid,uuid,jsonb) TO service_role;