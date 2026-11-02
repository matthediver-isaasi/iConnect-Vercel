-- Staged storage only. No tenant is enabled and no existing membership is changed.
-- Checkout may only be connected once cross-provider reservation and settlement
-- consumers use this journal in the same transaction as the successor election.
BEGIN;

CREATE TABLE IF NOT EXISTS public.membership_post_grace_policy (
  tenant_id uuid PRIMARY KEY REFERENCES public.tenant(id),
  enabled boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS public.membership_post_grace_renewal (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenant(id),
  member_id uuid NOT NULL REFERENCES public.member(id),
  previous_term_id uuid NOT NULL REFERENCES public.member_membership_history(id),
  config_id uuid NOT NULL REFERENCES public.membership_tier_config(id),
  election_id uuid NOT NULL UNIQUE REFERENCES public.membership_successor_election(id),
  payment_method text NOT NULL CHECK (payment_method IN ('upfront','monthly_card','direct_debit')),
  first_payment_minor bigint NOT NULL CHECK (first_payment_minor >= 0),
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  grace_end_date date NOT NULL,
  status text NOT NULL DEFAULT 'reserved' CHECK (status IN ('reserved','settled','released')),
  created_at timestamptz NOT NULL DEFAULT now(),
  payment_provider text CHECK (payment_provider IN ('stripe','gocardless','credit')),
  payment_id text,
  paid_at timestamptz,
  term_start_date date,
  term_end_date date,
  CHECK ((status = 'settled') = (payment_provider IS NOT NULL AND payment_id IS NOT NULL
    AND paid_at IS NOT NULL AND term_start_date IS NOT NULL AND term_end_date IS NOT NULL)),
  CHECK (status = 'settled' OR (payment_provider IS NULL AND payment_id IS NULL
    AND paid_at IS NULL AND term_start_date IS NULL AND term_end_date IS NULL)),
  CHECK (term_start_date IS NULL OR term_start_date > grace_end_date),
  CHECK (term_end_date IS NULL OR term_end_date >= term_start_date),
  CHECK (paid_at IS NULL OR paid_at >= created_at)
);
CREATE UNIQUE INDEX IF NOT EXISTS membership_post_grace_unresolved_predecessor
  ON public.membership_post_grace_renewal(tenant_id,member_id,previous_term_id) WHERE status <> 'released';
CREATE UNIQUE INDEX IF NOT EXISTS membership_post_grace_payment_once
  ON public.membership_post_grace_renewal(tenant_id,payment_provider,payment_id) WHERE payment_id IS NOT NULL;

ALTER TABLE public.membership_post_grace_policy ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.membership_post_grace_renewal ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.membership_post_grace_policy,public.membership_post_grace_renewal FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.membership_post_grace_policy,public.membership_post_grace_renewal TO service_role;

CREATE OR REPLACE FUNCTION public.guard_post_grace_renewal_journal() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE h public.member_membership_history%ROWTYPE; e public.membership_successor_election%ROWTYPE;
  c public.membership_tier_config%ROWTYPE; policy jsonb; expected_grace date; grace integer;
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Post-grace payment evidence cannot be deleted'; END IF;
  IF TG_OP = 'UPDATE' THEN
    IF (to_jsonb(NEW) - ARRAY['status','payment_provider','payment_id','paid_at','term_start_date','term_end_date'])
      IS DISTINCT FROM
      (to_jsonb(OLD) - ARRAY['status','payment_provider','payment_id','paid_at','term_start_date','term_end_date']) THEN
      RAISE EXCEPTION 'Post-grace reservation provenance is immutable';
    END IF;
    IF OLD.status <> 'reserved' AND NEW IS DISTINCT FROM OLD THEN
      RAISE EXCEPTION 'Final post-grace evidence is immutable';
    END IF;
    RETURN NEW;
  END IF;
  -- Existing election remains the cross-provider lock authority. This journal
  -- alone cannot authorize another checkout or change any purchased term.
  SELECT * INTO e FROM public.membership_successor_election WHERE id=NEW.election_id;
  SELECT * INTO h FROM public.member_membership_history WHERE id=NEW.previous_term_id;
  SELECT * INTO c FROM public.membership_tier_config WHERE id=NEW.config_id;
  IF e.id IS NULL OR h.id IS NULL OR c.id IS NULL
    OR e.tenant_id IS DISTINCT FROM NEW.tenant_id OR h.tenant_id IS DISTINCT FROM NEW.tenant_id
    OR c.tenant_id IS DISTINCT FROM NEW.tenant_id OR e.member_id IS DISTINCT FROM NEW.member_id
    OR h.member_id IS DISTINCT FROM NEW.member_id OR e.organization_id IS NOT NULL
    OR e.previous_term_id IS DISTINCT FROM h.id OR e.payment_method IS DISTINCT FROM NEW.payment_method
    OR e.status IS DISTINCT FROM 'reserved' OR e.origin IS DISTINCT FROM 'form'
    OR h.payment_status IS DISTINCT FROM 'paid' OR h.billing_agreement_id IS NOT NULL
    OR h.term_start_date IS NULL OR h.term_end_date IS NULL
    OR c.structure_scope_type IS DISTINCT FROM 'member' OR c.billing_period IS DISTINCT FROM 'annual'
    OR c.is_active IS FALSE
    OR NOT EXISTS (SELECT FROM public.member WHERE id=NEW.member_id AND tenant_id=NEW.tenant_id) THEN
    RAISE EXCEPTION 'Post-grace reservation scope or authority is invalid';
  END IF;
  policy := coalesce(h.renewal_policy_snapshot,h.commitment_snapshot->'config',h.incentive_snapshot->'config');
  IF policy->>'renewal_grace_days' IS NULL OR policy->>'renewal_grace_days' !~ '^[0-9]+$' THEN
    RAISE EXCEPTION 'Post-grace reservation requires saved grace policy';
  END IF;
  grace := (policy->>'renewal_grace_days')::integer;
  IF grace NOT BETWEEN 0 AND 366 THEN RAISE EXCEPTION 'Invalid grace policy'; END IF;
  expected_grace := h.term_end_date + grace + CASE WHEN h.term_key LIKE 'rolling:%' THEN 1 ELSE 0 END;
  IF NEW.grace_end_date IS DISTINCT FROM expected_grace
    OR (NEW.created_at AT TIME ZONE 'UTC')::date <= expected_grace
    OR NEW.status <> 'reserved'
    OR NOT EXISTS (SELECT FROM public.membership_post_grace_policy WHERE tenant_id=NEW.tenant_id AND enabled) THEN
    RAISE EXCEPTION 'Post-grace renewal is not enabled or grace has not ended';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.guard_post_grace_renewal_journal() FROM PUBLIC,anon,authenticated,service_role;
DROP TRIGGER IF EXISTS guard_post_grace_renewal_journal ON public.membership_post_grace_renewal;
CREATE TRIGGER guard_post_grace_renewal_journal BEFORE INSERT OR UPDATE OR DELETE
  ON public.membership_post_grace_renewal FOR EACH ROW EXECUTE FUNCTION public.guard_post_grace_renewal_journal();

CREATE OR REPLACE FUNCTION public.record_post_grace_payment(
  p_tenant_id uuid,p_member_id uuid,p_reservation_id uuid,p_provider text,p_payment_id text,
  p_status text,p_paid_at timestamptz,p_amount_minor bigint,p_currency text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE r public.membership_post_grace_renewal%ROWTYPE; start_date date;
BEGIN
  SELECT * INTO r FROM public.membership_post_grace_renewal
    WHERE id=p_reservation_id AND tenant_id=p_tenant_id AND member_id=p_member_id FOR UPDATE;
  IF NOT FOUND OR r.status='released' THEN RAISE EXCEPTION 'Post-grace reservation unavailable'; END IF;
  IF p_provider IS NULL OR p_status IS NULL OR nullif(btrim(p_payment_id),'') IS NULL
    OR NOT ((p_provider='stripe' AND p_status='succeeded')
      OR (p_provider='gocardless' AND p_status IN ('confirmed','paid_out'))
      OR (p_provider='credit' AND p_status='fully_allocated' AND r.payment_method='upfront'))
    OR NOT ((p_provider='stripe' AND r.payment_method IN ('upfront','monthly_card'))
      OR (p_provider='gocardless' AND r.payment_method='direct_debit')
      OR (p_provider='credit' AND r.payment_method='upfront'))
    OR p_paid_at IS NULL OR p_paid_at > now() OR p_paid_at < r.created_at
    OR p_amount_minor IS DISTINCT FROM r.first_payment_minor OR p_currency IS DISTINCT FROM r.currency
    OR (p_provider <> 'credit' AND p_amount_minor <= 0) THEN
    RAISE EXCEPTION 'Confirmed scoped payment evidence does not match post-grace reservation';
  END IF;
  IF r.status='settled' THEN
    IF r.payment_provider IS DISTINCT FROM p_provider OR r.payment_id IS DISTINCT FROM p_payment_id
      OR r.paid_at IS DISTINCT FROM p_paid_at THEN
      RAISE EXCEPTION 'Post-grace reservation already has different settlement evidence';
    END IF;
    RETURN to_jsonb(r);
  END IF;
  start_date := (p_paid_at AT TIME ZONE 'UTC')::date;
  IF start_date <= r.grace_end_date THEN RAISE EXCEPTION 'Payment is not after grace'; END IF;
  UPDATE public.membership_post_grace_renewal SET status='settled',payment_provider=p_provider,
    payment_id=p_payment_id,paid_at=p_paid_at,term_start_date=start_date,
    term_end_date=(start_date + interval '1 year')::date - 1
    WHERE id=r.id RETURNING * INTO r;
  RETURN to_jsonb(r);
END $$;
REVOKE ALL ON FUNCTION public.record_post_grace_payment(uuid,uuid,uuid,text,text,text,timestamptz,bigint,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.record_post_grace_payment(uuid,uuid,uuid,text,text,text,timestamptz,bigint,text) TO service_role;
COMMIT;
