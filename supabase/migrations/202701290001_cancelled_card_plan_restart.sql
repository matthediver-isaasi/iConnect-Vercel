-- Restart after a confirmed-cancelled individual Stripe monthly card plan.
--
-- Extends the confirmed-cancelled Direct Debit restart (202701280001) to card
-- plans, reusing its insert-only supersession receipt, reservation, journal
-- and finalizer patches. Only the shared evidence, the receipt's provider
-- identity and the two places that read the cancelled agreement's status
-- change here.
--
-- Stripe confirmation: the card plan was moved to payment_plan_cancelled by
-- Stripe itself (customer.subscription.deleted webhook, or reconciliation that
-- retrieved the subscription as canceled), recorded in the payment status
-- audit trail. A card agreement is not moved to a cancelled status when its
-- subscription ends, so the exact bound card agreement is recognised by its
-- receipt, never by ignoring open agreements generally.
--
-- The cancelled agreement, plan, unpaid instalments and arrears are retained
-- exactly; the predecessor keeps its dates, payment status and debt, and only
-- becomes status 'expired' once the new payment is confirmed.
--
-- Re-runnable; every patch of an installed function uses a unique anchor so a
-- drifted live contract fails the migration instead of being overwritten.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='60s';

ALTER TABLE public.membership_dd_restart_supersession
  ADD COLUMN IF NOT EXISTS provider text NOT NULL DEFAULT 'gocardless',
  ADD COLUMN IF NOT EXISTS stripe_subscription_id text;
ALTER TABLE public.membership_dd_restart_supersession ALTER COLUMN mandate_status DROP NOT NULL;
DO $c$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_constraint WHERE conrelid='public.membership_dd_restart_supersession'::regclass
      AND conname='membership_dd_restart_supersession_provider_evidence') THEN
    ALTER TABLE public.membership_dd_restart_supersession ADD CONSTRAINT membership_dd_restart_supersession_provider_evidence
      CHECK ((provider='gocardless' AND mandate_status IS NOT NULL AND stripe_subscription_id IS NULL)
        OR (provider='stripe' AND mandate_status IS NULL AND stripe_subscription_id IS NOT NULL));
  END IF;
END $c$;

-- Provider identity is derived from the bound agreement and plan on insert,
-- so the already-installed reservation insert needs no change.
CREATE OR REPLACE FUNCTION public.guard_membership_dd_restart_supersession()
RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE agreement_provider text; plan_provider text; subscription text;
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Restart supersession evidence cannot be deleted'; END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.superseded_at IS NOT NULL THEN RAISE EXCEPTION 'Restart supersession starts unsuperseded'; END IF;
    SELECT provider INTO agreement_provider FROM public.membership_billing_agreements
      WHERE id=NEW.agreement_id AND tenant_id=NEW.tenant_id AND member_id=NEW.member_id;
    SELECT provider,stripe_subscription_id INTO plan_provider,subscription FROM public.membership_payment_plans
      WHERE id=NEW.plan_id AND tenant_id=NEW.tenant_id AND member_id=NEW.member_id
        AND billing_agreement_id=NEW.agreement_id;
    IF agreement_provider IS NULL OR agreement_provider IS DISTINCT FROM plan_provider
      OR agreement_provider NOT IN ('gocardless','stripe') THEN
      RAISE EXCEPTION 'Restart supersession requires one bound payment provider';
    END IF;
    NEW.provider:=agreement_provider;
    NEW.stripe_subscription_id:=CASE WHEN agreement_provider='stripe' THEN subscription END;
    RETURN NEW;
  END IF;
  -- Only the single confirmed-payment transition is permitted.
  IF OLD.superseded_at IS NOT NULL OR NEW.superseded_at IS NULL
    OR (to_jsonb(NEW)-ARRAY['superseded_at','successor_history_id','reservation_id'])
      IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['superseded_at','successor_history_id','reservation_id']) THEN
    RAISE EXCEPTION 'Restart supersession evidence is immutable';
  END IF;
  RETURN NEW;
END $$;

-- Shared confirmed-cancelled evidence for both providers.
CREATE OR REPLACE FUNCTION public.membership_cancelled_dd_restart_evidence(
  p_tenant_id uuid,p_member_id uuid,p_history_id uuid
) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE h jsonb; a jsonb; p jsonb; s jsonb; mandate_status text; plans integer; confirmed_at timestamptz;
  cancelled text[]:=ARRAY['payment_plan_cancelled','cancelled','canceled'];
BEGIN
  SELECT to_jsonb(x) INTO h FROM public.member_membership_history x
    WHERE id=p_history_id AND tenant_id=p_tenant_id AND member_id=p_member_id;
  IF h IS NULL OR h->>'organization_id' IS NOT NULL OR h->>'billing_agreement_id' IS NULL
    OR h->>'payment_grace_exit_id' IS NOT NULL
    OR h->>'term_start_date' IS NULL OR h->>'term_end_date' IS NULL THEN RETURN NULL; END IF;
  IF h->>'restart_supersession_id' IS NOT NULL THEN
    SELECT to_jsonb(x) INTO s FROM public.membership_dd_restart_supersession x
      WHERE id=(h->>'restart_supersession_id')::uuid AND history_id=p_history_id
        AND tenant_id=p_tenant_id AND member_id=p_member_id
        AND agreement_id=(h->>'billing_agreement_id')::uuid
        AND original_term_start_date=(h->>'term_start_date')::date
        AND original_term_end_date=(h->>'term_end_date')::date;
    IF s IS NULL THEN RETURN NULL; END IF;
  ELSIF coalesce(h->>'status','') IN ('cancelled','canceled','void','expired_checkout','replaced','cancelled_by_request') THEN
    RETURN NULL;
  END IF;
  SELECT to_jsonb(x) INTO a FROM public.membership_billing_agreements x
    WHERE id=(h->>'billing_agreement_id')::uuid AND tenant_id=p_tenant_id AND member_id=p_member_id;
  IF a IS NULL OR a->>'organization_id' IS NOT NULL OR a->>'cancelled_for_switch_at' IS NOT NULL
    OR coalesce(a->>'provider','') NOT IN ('gocardless','stripe') THEN RETURN NULL; END IF;
  SELECT count(*) INTO plans FROM public.membership_payment_plans WHERE billing_agreement_id=(a->>'id')::uuid;
  IF plans<>1 THEN RETURN NULL; END IF;
  SELECT to_jsonb(x) INTO p FROM public.membership_payment_plans x
    WHERE billing_agreement_id=(a->>'id')::uuid AND tenant_id=p_tenant_id AND member_id=p_member_id;
  IF p IS NULL OR p->>'organization_id' IS NOT NULL OR p->>'provider' IS DISTINCT FROM a->>'provider'
    OR NOT (p->>'status' = ANY(cancelled)) THEN RETURN NULL; END IF;
  IF s IS NOT NULL AND s->>'provider' IS DISTINCT FROM a->>'provider' THEN RETURN NULL; END IF;

  IF a->>'provider'='gocardless' THEN
    -- Mirrors the GoCardless webhook's terminal confirmation: an API-confirmed
    -- cancelled/failed/expired mandate moves agreement and plan to cancelled.
    IF NOT (a->>'status' = ANY(cancelled)) OR a->>'gocardless_mandate_id' IS NULL THEN RETURN NULL; END IF;
    SELECT m.status INTO mandate_status FROM public.gocardless_mandates m
      WHERE m.tenant_id=p_tenant_id AND m.gocardless_mandate_id=a->>'gocardless_mandate_id'
        AND m.environment IS NOT DISTINCT FROM a->>'environment';
    IF mandate_status IS NULL OR mandate_status NOT IN ('cancelled','failed','expired') THEN RETURN NULL; END IF;
    RETURN jsonb_build_object('provider','gocardless','tenant_id',p_tenant_id,'member_id',p_member_id,
      'history_id',p_history_id,'agreement_id',a->'id','plan_id',p->'id','agreement_status',a->'status',
      'plan_status',p->'status','mandate_status',mandate_status,'supersession',s);
  END IF;

  -- Stripe monthly card plan: an unfinished subscription that Stripe itself
  -- reported as ended. A completed plan, a duplicate-checkout conflict and an
  -- agreement already concluded are not cancellations.
  IF a->'metadata'->'card'->>'kind' IS DISTINCT FROM 'monthly_card'
    OR a->'metadata'->'form_conflict_resolution' IS NOT NULL
    OR coalesce(a->>'status','') IN ('completed','expired')
    OR nullif(p->>'stripe_subscription_id','') IS NULL
    OR p->>'completed_at' IS NOT NULL OR p->>'status' IS DISTINCT FROM 'payment_plan_cancelled' THEN
    RETURN NULL;
  END IF;
  SELECT min(created_at) INTO confirmed_at FROM public.membership_payment_status_history
    WHERE tenant_id=p_tenant_id AND entity_type='payment_plan' AND entity_id=(p->>'id')::uuid
      AND to_status='payment_plan_cancelled' AND source IN ('webhook','reconciliation');
  IF confirmed_at IS NULL THEN RETURN NULL; END IF;
  RETURN jsonb_build_object('provider','stripe','tenant_id',p_tenant_id,'member_id',p_member_id,
    'history_id',p_history_id,'agreement_id',a->'id','plan_id',p->'id','agreement_status',a->'status',
    'plan_status',p->'status','stripe_subscription_id',p->'stripe_subscription_id',
    'cancellation_confirmed_at',confirmed_at,'supersession',s);
END $$;
REVOKE ALL ON FUNCTION public.membership_cancelled_dd_restart_evidence(uuid,uuid,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.membership_cancelled_dd_restart_evidence(uuid,uuid,uuid) TO service_role;

-- The agreement of a predecessor bound to a restart reservation: a cancelled
-- Direct Debit, or the exact card agreement whose bound plan is still the
-- Stripe-cancelled plan. Used by the invoker-rights upfront quote guard.
CREATE OR REPLACE FUNCTION public.membership_restart_linked_agreement(p_agreement_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
  SELECT EXISTS (SELECT FROM public.membership_dd_restart_supersession s
    JOIN public.member_membership_history h ON h.restart_supersession_id=s.id AND h.id=s.history_id
      AND h.billing_agreement_id=s.agreement_id
    JOIN public.membership_billing_agreements a ON a.id=s.agreement_id AND a.tenant_id=s.tenant_id
      AND a.member_id=s.member_id AND a.organization_id IS NULL
    WHERE s.agreement_id=p_agreement_id
      AND ((s.provider='gocardless' AND a.status IN ('payment_plan_cancelled','cancelled','canceled'))
        OR (s.provider='stripe' AND a.provider='stripe' AND EXISTS (
          SELECT FROM public.membership_payment_plans p
          WHERE p.id=s.plan_id AND p.billing_agreement_id=s.agreement_id AND p.provider='stripe'
            AND p.status='payment_plan_cancelled' AND p.stripe_subscription_id=s.stripe_subscription_id))));
$$;
REVOKE ALL ON FUNCTION public.membership_restart_linked_agreement(uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.membership_restart_linked_agreement(uuid) TO authenticated,service_role;

DO $patch$
DECLARE source text; signature text; anchor text;
BEGIN
  -- Finalizer: the bound card agreement keeps its own (non-cancelled) status.
  signature:='public.apply_post_grace_record_dates(uuid,uuid,uuid,text,text,text,timestamptz,bigint,text,jsonb)';
  source:=pg_get_functiondef(signature::regprocedure);
  IF position('restart_supersession_card_agreement' IN source)=0 THEN
    anchor:=E'r.previous_term_id)->>''agreement_id'')::uuid\n        AND x.status IN (''payment_plan_cancelled'',''cancelled'',''canceled''))) THEN';
    IF (length(source)-length(replace(source,anchor,'')))/length(anchor)<>1 THEN
      RAISE EXCEPTION 'Post-grace finalizer contract changed: %',anchor;
    END IF;
    source:=replace(source,anchor,E'r.previous_term_id)->>''agreement_id'')::uuid\n        AND (x.status IN (''payment_plan_cancelled'',''cancelled'',''canceled'')\n          -- restart_supersession_card_agreement\n          OR (x.provider=''stripe'' AND public.membership_dd_restart_receipt(\n            p_tenant_id,p_member_id,r.previous_term_id)->>''provider''=''stripe'')))) THEN');
    EXECUTE source;
  END IF;
END $patch$;
COMMIT;
