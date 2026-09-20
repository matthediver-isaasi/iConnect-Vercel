-- Alpha only: installing this schema does not release any member.
-- Arming is a separately reviewed, atomic, privileged transaction.
LOCK TABLE public.gocardless_collection_reservations IN SHARE ROW EXCLUSIVE MODE;
DO $$ BEGIN
  IF EXISTS(SELECT FROM public.gocardless_collection_reservations r JOIN public.bnms_dd_alpha_adoption a ON a.plan_id=r.plan_id) THEN
    RAISE EXCEPTION 'Alpha reservations exist; reconcile before release schema';
  END IF;
END $$;
CREATE TABLE public.bnms_dd_alpha_release (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  adoption_id uuid NOT NULL UNIQUE,
  tenant_id uuid NOT NULL CHECK(tenant_id='ff2df806-b321-4254-b651-3af11fccf1db'),
  member_id uuid NOT NULL UNIQUE,
  plan_id uuid NOT NULL UNIQUE REFERENCES public.membership_payment_plans(id),
  evidence_sha256 text NOT NULL CHECK(evidence_sha256 ~ '^[a-f0-9]{64}$'),
  evidence jsonb NOT NULL,
  processing_not_before timestamptz NOT NULL DEFAULT '2026-10-01 00:00:00 Europe/London'
    CHECK(processing_not_before=TIMESTAMPTZ '2026-10-01 00:00:00 Europe/London'),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(adoption_id,tenant_id,member_id) REFERENCES public.bnms_dd_alpha_adoption(id,tenant_id,member_id)
);
ALTER TABLE public.bnms_dd_alpha_release ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.bnms_dd_alpha_release FROM PUBLIC;
DO $$ DECLARE r text; BEGIN
  FOREACH r IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
    IF EXISTS(SELECT FROM pg_roles WHERE rolname=r) THEN
      EXECUTE format('REVOKE ALL ON public.bnms_dd_alpha_release FROM %I',r);
      IF r='service_role' THEN GRANT SELECT ON public.bnms_dd_alpha_release TO service_role; END IF;
    END IF;
  END LOOP;
END $$;
CREATE TRIGGER alpha_release_immutable BEFORE UPDATE OR DELETE ON public.bnms_dd_alpha_release
FOR EACH ROW EXECUTE FUNCTION public.bnms_dd_reject_history_mutation();
CREATE FUNCTION public.bnms_dd_alpha_release_owner_guard() RETURNS trigger LANGUAGE plpgsql
SET search_path=public AS $$ BEGIN
  IF NOT EXISTS(SELECT FROM bnms_dd_alpha_adoption a
    WHERE a.id=NEW.adoption_id AND a.tenant_id=NEW.tenant_id AND a.member_id=NEW.member_id AND a.plan_id=NEW.plan_id
    AND a.manifest_sha256='3aff20a6e04338c3b3532d57c6be4b8395afa5ff8d5dbbe878daab52017f395a'
    AND NEW.evidence->>'adoptionId'=a.id::text AND NEW.evidence->>'planId'=a.plan_id::text
    AND NEW.evidence->>'agreementId'=a.agreement_id::text
    AND NEW.evidence->>'memberId'=a.member_id::text
    AND NEW.evidence->>'mandateId'=a.mandate_id
    AND NEW.evidence->>'customerId'=a.customer_id
    AND NEW.evidence->>'processingNotBefore'='2026-09-30T23:00:00Z'
    AND (NEW.evidence->'price'->>'monthly_amount_minor')::integer>0
    AND (NEW.evidence->'price'->>'monthly_amount_minor')::integer=(a.evidence->>'monthlyQuoteMinor')::integer
    AND NEW.evidence->'price'->>'currency'='GBP') THEN
    RAISE EXCEPTION 'Reviewed alpha release owner/evidence mismatch';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER alpha_release_owner BEFORE INSERT ON public.bnms_dd_alpha_release
FOR EACH ROW EXECUTE FUNCTION public.bnms_dd_alpha_release_owner_guard();

CREATE OR REPLACE FUNCTION public.bnms_dd_alpha_hold_guard() RETURNS trigger LANGUAGE plpgsql
SET search_path=public AS $$
DECLARE a public.bnms_dd_alpha_adoption; released public.bnms_dd_alpha_release;
BEGIN
  IF TG_TABLE_NAME='membership_payment_plans' THEN
    SELECT * INTO a FROM bnms_dd_alpha_adoption WHERE plan_id=OLD.id;
  ELSE
    SELECT * INTO a FROM bnms_dd_alpha_adoption WHERE plan_id=NEW.plan_id;
  END IF;
  IF NOT FOUND THEN
    IF TG_OP='DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Alpha adopted plan cannot be deleted'; END IF;
  SELECT * INTO released FROM bnms_dd_alpha_release WHERE adoption_id=a.id;
  IF NOT FOUND THEN
    -- Preserve the existing alpha hold (stricter than beta's metadata allowance).
    RAISE EXCEPTION 'Alpha collection requires reviewed release';
  END IF;
  IF NEW.tenant_id IS DISTINCT FROM a.tenant_id THEN RAISE EXCEPTION 'Alpha tenant drift'; END IF;
  IF TG_TABLE_NAME='membership_payment_plans' THEN
    IF NEW.member_id IS DISTINCT FROM a.member_id OR NEW.id IS DISTINCT FROM a.plan_id
      OR NEW.billing_agreement_id IS DISTINCT FROM a.agreement_id
      OR NEW.gocardless_mandate_id IS DISTINCT FROM a.mandate_id
      OR NEW.gocardless_subscription_id IS NOT NULL OR NEW.provider IS DISTINCT FROM 'gocardless'
      OR NEW.environment IS DISTINCT FROM 'live'
      OR NEW.metadata->>'collection_mode' IS DISTINCT FROM 'dynamic'
      OR NEW.metadata->>'dynamic_first_date' IS DISTINCT FROM '2026-10-01'
      OR NEW.metadata->>'bnms_alpha_held' IS DISTINCT FROM 'true'
      OR NEW.metadata->>'bnms_release_required' IS DISTINCT FROM 'false' THEN
      RAISE EXCEPTION 'Released alpha identity/cadence/provenance drift';
    END IF;
  ELSE
    -- Database clock blocks even the old worker from submitting early.
    IF clock_timestamp()<released.processing_not_before THEN
      RAISE EXCEPTION 'BNMS alpha processing-not-before October 1 Europe/London';
    END IF;
    IF NEW.billing_agreement_id IS DISTINCT FROM a.agreement_id THEN RAISE EXCEPTION 'Alpha reservation agreement drift'; END IF;
    IF TG_OP='INSERT' AND NEW.requested_charge_date<(clock_timestamp() AT TIME ZONE 'Europe/London')::date THEN
      RAISE EXCEPTION 'Alpha requested date is in the past';
    END IF;
    IF NEW.collection_number=1 AND (
      NEW.due_date IS DISTINCT FROM '2026-10-01'::date
      OR NEW.requested_charge_date IS NULL OR NEW.requested_charge_date NOT BETWEEN '2026-10-01'::date AND '2026-10-08'::date
      OR NEW.amount_minor IS DISTINCT FROM (released.evidence->'price'->>'monthly_amount_minor')::integer
      OR NEW.currency IS DISTINCT FROM 'GBP'
      OR NEW.requested_charge_date IS DISTINCT FROM (NEW.provider_evidence->>'next_possible_charge_date')::date
      OR (TG_OP='INSERT' AND NEW.provider_evidence->>'status' IS DISTINCT FROM 'active')
      OR (TG_OP='UPDATE' AND (
        NEW.provider_evidence->>'next_possible_charge_date' IS DISTINCT FROM OLD.provider_evidence->>'next_possible_charge_date'
        OR NEW.provider_evidence->>'checked_at' IS DISTINCT FROM OLD.provider_evidence->>'checked_at'))
      OR (NEW.provider_evidence->>'checked_at')::timestamptz IS NULL
      OR (NEW.provider_evidence->>'checked_at')::timestamptz<released.processing_not_before
    ) THEN RAISE EXCEPTION 'Alpha first collection requires reviewed price/cadence and post-gate provider evidence'; END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION public.bnms_dd_alpha_canonical_guard() RETURNS trigger LANGUAGE plpgsql
SET search_path=public AS $$
DECLARE a public.bnms_dd_alpha_adoption;
BEGIN
  IF TG_TABLE_NAME='membership_billing_agreements' THEN
    SELECT * INTO a FROM bnms_dd_alpha_adoption WHERE agreement_id=OLD.id;
  ELSE SELECT * INTO a FROM bnms_dd_alpha_adoption WHERE history_id=OLD.id;
  END IF;
  IF NOT FOUND THEN
    IF TG_OP='DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Alpha adopted canonical record cannot be deleted'; END IF;
  IF NOT EXISTS(SELECT FROM bnms_dd_alpha_release WHERE adoption_id=a.id) THEN
    RAISE EXCEPTION 'Alpha canonical records require reviewed release';
  END IF;
  IF NEW.tenant_id IS DISTINCT FROM a.tenant_id OR NEW.member_id IS DISTINCT FROM a.member_id THEN
    RAISE EXCEPTION 'Released alpha owner drift';
  END IF;
  IF TG_TABLE_NAME='membership_billing_agreements' THEN
    IF NEW.id IS DISTINCT FROM a.agreement_id
      OR NEW.gocardless_mandate_id IS DISTINCT FROM a.mandate_id
      OR NEW.gocardless_customer_id IS DISTINCT FROM a.customer_id
      OR NEW.provider IS DISTINCT FROM 'gocardless' OR NEW.environment IS DISTINCT FROM 'live'
      OR NEW.metadata->'dd' IS DISTINCT FROM OLD.metadata->'dd'
      OR NEW.metadata->'commitment' IS DISTINCT FROM OLD.metadata->'commitment'
      OR NEW.metadata->'bnms_alpha_approval' IS DISTINCT FROM OLD.metadata->'bnms_alpha_approval' THEN
      RAISE EXCEPTION 'Released alpha immutable consent/provider drift';
    END IF;
  ELSE
    IF NEW.id IS DISTINCT FROM a.history_id OR NEW.billing_agreement_id IS DISTINCT FROM a.agreement_id
      OR (to_jsonb(NEW)-ARRAY['status','payment_status','paid_at','updated_at','notes'])
        IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['status','payment_status','paid_at','updated_at','notes']) THEN
      RAISE EXCEPTION 'Released alpha membership financial/dated terms are immutable';
    END IF;
    IF (NEW.status='active' OR NEW.payment_status IN ('paid','partial') OR NEW.paid_at IS NOT NULL)
      AND NOT EXISTS(SELECT FROM gocardless_payments p
        JOIN gocardless_collection_reservations r ON r.gocardless_payment_id=p.gocardless_payment_id
        WHERE p.tenant_id=a.tenant_id AND r.tenant_id=a.tenant_id AND r.plan_id=a.plan_id
        AND r.billing_agreement_id=a.agreement_id AND r.collection_number=1
        AND p.gocardless_mandate_id=a.mandate_id AND p.charge_date>='2026-10-01'::date
        AND p.status IN ('confirmed','paid_out')) THEN
      RAISE EXCEPTION 'Alpha activation requires confirmed first managed payment';
    END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION public.bnms_dd_alpha_protect_payment() RETURNS trigger LANGUAGE plpgsql
SET search_path=public AS $$
DECLARE a public.bnms_dd_alpha_adoption;
BEGIN
  IF EXISTS(SELECT FROM bnms_dd_alpha_provider_history WHERE provider_payment_id=NEW.gocardless_payment_id)
    OR (TG_OP='UPDATE' AND EXISTS(SELECT FROM bnms_dd_alpha_provider_history WHERE provider_payment_id=OLD.gocardless_payment_id)) THEN
    RAISE EXCEPTION 'Alpha historical evidence cannot enter mutable payments';
  END IF;
  SELECT * INTO a FROM bnms_dd_alpha_adoption WHERE mandate_id=NEW.gocardless_mandate_id;
  IF FOUND THEN
    IF NEW.tenant_id IS DISTINCT FROM a.tenant_id
      OR NOT EXISTS(SELECT FROM bnms_dd_alpha_release WHERE adoption_id=a.id)
      OR clock_timestamp()<TIMESTAMPTZ '2026-10-01 00:00:00 Europe/London'
      OR NEW.charge_date IS NULL OR NEW.charge_date<'2026-10-01'::date THEN
      RAISE EXCEPTION 'Alpha held or pre-gate mandate cannot enter mutable payments';
    END IF;
  END IF;
  IF TG_OP='UPDATE' AND EXISTS(SELECT FROM bnms_dd_alpha_adoption WHERE mandate_id=OLD.gocardless_mandate_id)
    AND (NEW.gocardless_mandate_id IS DISTINCT FROM OLD.gocardless_mandate_id
      OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
      OR NEW.gocardless_payment_id IS DISTINCT FROM OLD.gocardless_payment_id) THEN
    RAISE EXCEPTION 'Alpha mutable payment identity drift';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER bnms_dd_alpha_agreement_hold ON public.membership_billing_agreements;
CREATE TRIGGER bnms_dd_alpha_agreement_hold BEFORE UPDATE OR DELETE ON public.membership_billing_agreements
FOR EACH ROW EXECUTE FUNCTION public.bnms_dd_alpha_canonical_guard();
DROP TRIGGER bnms_dd_alpha_history_hold ON public.member_membership_history;
CREATE TRIGGER bnms_dd_alpha_history_hold BEFORE UPDATE OR DELETE ON public.member_membership_history
FOR EACH ROW EXECUTE FUNCTION public.bnms_dd_alpha_canonical_guard();
DROP TRIGGER bnms_dd_alpha_no_historical_replay ON public.gocardless_payments;
CREATE TRIGGER bnms_dd_alpha_no_historical_replay BEFORE INSERT OR UPDATE ON public.gocardless_payments
FOR EACH ROW EXECUTE FUNCTION public.bnms_dd_alpha_protect_payment();