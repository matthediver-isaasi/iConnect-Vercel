-- Explicit beta arming only. Does not itself release any member, touch alpha,
-- change consent/entitlement, schedule a payment, or call a provider.
LOCK TABLE public.gocardless_collection_reservations IN SHARE ROW EXCLUSIVE MODE;
DO $$ BEGIN
  IF EXISTS(SELECT FROM gocardless_collection_reservations r JOIN bnms_dd_beta_adoption a ON a.plan_id=r.plan_id) THEN
    RAISE EXCEPTION 'Beta reservations exist; reconcile before release schema';
  END IF;
END $$;
CREATE TABLE public.bnms_dd_beta_release (
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
  FOREIGN KEY(adoption_id,tenant_id,member_id) REFERENCES public.bnms_dd_beta_adoption(id,tenant_id,member_id)
);
ALTER TABLE public.bnms_dd_beta_release ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.bnms_dd_beta_release FROM PUBLIC;
DO $$ DECLARE r text; BEGIN
  FOREACH r IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
    IF EXISTS(SELECT FROM pg_roles WHERE rolname=r) THEN
      EXECUTE format('REVOKE ALL ON public.bnms_dd_beta_release FROM %I',r);
      IF r='service_role' THEN GRANT SELECT ON public.bnms_dd_beta_release TO service_role; END IF;
    END IF;
  END LOOP;
END $$;
CREATE TRIGGER beta_release_immutable BEFORE UPDATE OR DELETE ON public.bnms_dd_beta_release
FOR EACH ROW EXECUTE FUNCTION public.bnms_dd_reject_history_mutation();
CREATE FUNCTION public.bnms_dd_beta_release_owner_guard() RETURNS trigger LANGUAGE plpgsql
SET search_path=public AS $$ BEGIN
  IF NOT EXISTS(SELECT FROM bnms_dd_beta_adoption a JOIN bnms_dd_beta_batch b ON b.id=a.batch_id
    WHERE a.id=NEW.adoption_id AND a.tenant_id=NEW.tenant_id AND a.member_id=NEW.member_id AND a.plan_id=NEW.plan_id
    AND b.evidence_sha256='aaeb5efa50de77db5b6213c23d32a71ae0aa19d88484f1afd911f49fa44739c2'
    AND NEW.evidence->>'adoptionId'=a.id::text AND NEW.evidence->>'planId'=a.plan_id::text
    AND NEW.evidence->>'memberId'=a.member_id::text
    AND NEW.evidence->>'mandateId'=a.mandate_id
    AND NEW.evidence->>'customerId'=a.customer_id
    AND NEW.evidence->>'processingNotBefore'='2026-09-30T23:00:00Z'
    AND (NEW.evidence->'price'->>'monthly_amount_minor')::integer>0
    AND NEW.evidence->'price'->>'currency'='GBP') THEN
    RAISE EXCEPTION 'Reviewed beta release owner/evidence mismatch';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER beta_release_owner BEFORE INSERT ON public.bnms_dd_beta_release
FOR EACH ROW EXECUTE FUNCTION public.bnms_dd_beta_release_owner_guard();

CREATE OR REPLACE FUNCTION public.bnms_dd_beta_hold_guard() RETURNS trigger LANGUAGE plpgsql
SET search_path=public AS $$
DECLARE a public.bnms_dd_beta_adoption; released public.bnms_dd_beta_release;
BEGIN
  IF TG_TABLE_NAME='membership_payment_plans' THEN
    SELECT * INTO a FROM bnms_dd_beta_adoption WHERE plan_id=OLD.id;
  ELSE
    SELECT * INTO a FROM bnms_dd_beta_adoption WHERE plan_id=NEW.plan_id;
  END IF;
  IF NOT FOUND THEN RETURN NEW; END IF;
  SELECT * INTO released FROM bnms_dd_beta_release WHERE adoption_id=a.id;
  IF NOT FOUND THEN
    IF TG_TABLE_NAME='membership_payment_plans' THEN
      IF NEW.collection_stopped_at IS NULL OR NEW.metadata->>'bnms_release_required' IS DISTINCT FROM 'true'
        OR (to_jsonb(NEW)-'metadata'-'updated_at') IS DISTINCT FROM (to_jsonb(OLD)-'metadata'-'updated_at')
        OR (SELECT jsonb_object_agg(k,NEW.metadata->k) FROM unnest(ARRAY['collection_mode','dynamic_first_date','agreement_id','bnms_release_required','bnms_beta_held']) k)
          IS DISTINCT FROM (SELECT jsonb_object_agg(k,OLD.metadata->k) FROM unnest(ARRAY['collection_mode','dynamic_first_date','agreement_id','bnms_release_required','bnms_beta_held']) k) THEN
        RAISE EXCEPTION 'Beta collection requires reviewed release';
      END IF;
    ELSE RAISE EXCEPTION 'Beta plans are held; collection reservation forbidden';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.tenant_id IS DISTINCT FROM a.tenant_id THEN RAISE EXCEPTION 'Beta tenant drift'; END IF;
  IF TG_TABLE_NAME='membership_payment_plans' THEN
    IF NEW.member_id IS DISTINCT FROM a.member_id OR NEW.id IS DISTINCT FROM a.plan_id
      OR NEW.billing_agreement_id IS DISTINCT FROM a.agreement_id
      OR NEW.gocardless_mandate_id IS DISTINCT FROM a.mandate_id
      OR NEW.gocardless_subscription_id IS NOT NULL OR NEW.provider IS DISTINCT FROM 'gocardless'
      OR NEW.environment IS DISTINCT FROM 'live'
      OR NEW.metadata->>'collection_mode' IS DISTINCT FROM 'dynamic'
      OR NEW.metadata->>'dynamic_first_date' IS DISTINCT FROM '2026-10-01'
      OR NEW.metadata->>'bnms_beta_held' IS DISTINCT FROM 'true'
      OR NEW.metadata->>'bnms_release_required' IS DISTINCT FROM 'false' THEN
      RAISE EXCEPTION 'Released beta identity/cadence/provenance drift';
    END IF;
  ELSE
    -- Database clock, not client evidence, prevents the old worker submitting early.
    IF clock_timestamp()<released.processing_not_before THEN
      RAISE EXCEPTION 'BNMS beta processing-not-before October 1 Europe/London';
    END IF;
    IF NEW.billing_agreement_id IS DISTINCT FROM a.agreement_id THEN RAISE EXCEPTION 'Beta reservation agreement drift'; END IF;
    IF TG_OP='INSERT' AND NEW.requested_charge_date<(clock_timestamp() AT TIME ZONE 'Europe/London')::date THEN
      RAISE EXCEPTION 'Beta requested date is in the past';
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
    ) THEN RAISE EXCEPTION 'Beta first collection requires reviewed price/cadence and post-gate provider evidence'; END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION public.bnms_dd_beta_canonical_guard() RETURNS trigger LANGUAGE plpgsql
SET search_path=public AS $$
DECLARE a public.bnms_dd_beta_adoption; armed boolean;
BEGIN
  IF TG_TABLE_NAME='membership_billing_agreements' THEN
    SELECT * INTO a FROM bnms_dd_beta_adoption WHERE agreement_id=OLD.id;
  ELSE SELECT * INTO a FROM bnms_dd_beta_adoption WHERE history_id=OLD.id;
  END IF;
  IF NOT FOUND THEN RETURN NEW; END IF;
  SELECT EXISTS(SELECT FROM bnms_dd_beta_release WHERE adoption_id=a.id) INTO armed;
  IF NOT armed THEN
    IF TG_TABLE_NAME='membership_billing_agreements' THEN
      IF (to_jsonb(NEW)-'metadata'-'updated_at'-'needs_attention'-'attention_reason')
        IS DISTINCT FROM (to_jsonb(OLD)-'metadata'-'updated_at'-'needs_attention'-'attention_reason')
        OR NEW.metadata->'dd' IS DISTINCT FROM OLD.metadata->'dd'
        OR NEW.metadata->'commitment' IS DISTINCT FROM OLD.metadata->'commitment'
        OR NEW.metadata->'bnms_beta_approval' IS DISTINCT FROM OLD.metadata->'bnms_beta_approval'
        OR NEW.metadata->'gocardless_initial_payment' IS DISTINCT FROM OLD.metadata->'gocardless_initial_payment' THEN
        RAISE EXCEPTION 'Held beta agreement identity and consent are immutable until reviewed release';
      END IF;
    ELSIF (to_jsonb(NEW)-'updated_at'-'notes') IS DISTINCT FROM (to_jsonb(OLD)-'updated_at'-'notes') THEN
      RAISE EXCEPTION 'Held beta membership cannot activate or change its financial or dated terms';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.tenant_id IS DISTINCT FROM a.tenant_id OR NEW.member_id IS DISTINCT FROM a.member_id THEN
    RAISE EXCEPTION 'Released beta owner drift';
  END IF;
  IF TG_TABLE_NAME='membership_billing_agreements' THEN
    IF NEW.id IS DISTINCT FROM a.agreement_id
      OR NEW.gocardless_mandate_id IS DISTINCT FROM a.mandate_id
      OR NEW.gocardless_customer_id IS DISTINCT FROM a.customer_id
      OR NEW.provider IS DISTINCT FROM 'gocardless' OR NEW.environment IS DISTINCT FROM 'live'
      OR NEW.metadata->'dd' IS DISTINCT FROM OLD.metadata->'dd'
      OR NEW.metadata->'commitment' IS DISTINCT FROM OLD.metadata->'commitment'
      OR NEW.metadata->'bnms_beta_approval' IS DISTINCT FROM OLD.metadata->'bnms_beta_approval' THEN
      RAISE EXCEPTION 'Released beta immutable consent/provider drift';
    END IF;
  ELSE
    IF NEW.id IS DISTINCT FROM a.history_id OR NEW.billing_agreement_id IS DISTINCT FROM a.agreement_id
      OR (to_jsonb(NEW)-ARRAY['status','payment_status','paid_at','updated_at','notes'])
        IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['status','payment_status','paid_at','updated_at','notes']) THEN
      RAISE EXCEPTION 'Released beta membership financial/dated terms are immutable';
    END IF;
    IF NEW.status='active' AND NOT EXISTS(SELECT FROM gocardless_payments p
      JOIN gocardless_collection_reservations r ON r.gocardless_payment_id=p.gocardless_payment_id
      WHERE p.tenant_id=a.tenant_id AND r.tenant_id=a.tenant_id AND r.plan_id=a.plan_id AND r.collection_number=1
      AND p.gocardless_mandate_id=a.mandate_id AND p.charge_date>='2026-10-01'::date
      AND p.status IN ('confirmed','paid_out')) THEN
      RAISE EXCEPTION 'Beta activation requires confirmed first managed payment';
    END IF;
  END IF;
  RETURN NEW;
END $$;