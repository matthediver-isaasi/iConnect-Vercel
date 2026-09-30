-- Beta evidence and HELD adoption only. No entitlement, accounting or release.
CREATE TABLE public.bnms_dd_beta_schema_revision (
  singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
  sql_sha256 text NOT NULL CHECK(sql_sha256 ~ '^[0-9a-f]{64}$'),
  catalog_sha256 text NOT NULL CHECK(catalog_sha256 ~ '^[0-9a-f]{64}$')
);
ALTER TABLE public.bnms_dd_beta_schema_revision ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.bnms_dd_beta_schema_revision FROM PUBLIC;
CREATE TABLE public.bnms_dd_beta_batch (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL CHECK (tenant_id='ff2df806-b321-4254-b651-3af11fccf1db'),
  evidence_sha256 text NOT NULL UNIQUE CHECK(evidence_sha256 ~ '^[0-9a-f]{64}$'),
  evidence jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.bnms_dd_beta_adoption (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id uuid NOT NULL REFERENCES public.bnms_dd_beta_batch(id),
  tenant_id uuid NOT NULL CHECK (tenant_id='ff2df806-b321-4254-b651-3af11fccf1db'),
  member_id uuid NOT NULL UNIQUE REFERENCES public.member(id)
    CHECK(member_id <> '33e5d54d-162e-436d-9bff-ec6676d198f9'),
  mandate_id text NOT NULL UNIQUE,
  customer_id text NOT NULL UNIQUE,
  agreement_id uuid NOT NULL UNIQUE REFERENCES public.membership_billing_agreements(id),
  plan_id uuid NOT NULL UNIQUE REFERENCES public.membership_payment_plans(id),
  history_id uuid NOT NULL UNIQUE REFERENCES public.member_membership_history(id),
  evidence jsonb NOT NULL,
  UNIQUE(id,tenant_id,member_id)
);
CREATE TABLE public.bnms_dd_beta_provider_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  adoption_id uuid NOT NULL,
  tenant_id uuid NOT NULL CHECK (tenant_id='ff2df806-b321-4254-b651-3af11fccf1db'),
  member_id uuid NOT NULL,
  provider_payment_id text NOT NULL UNIQUE,
  charge_date date NOT NULL CHECK(charge_date < '2026-10-01'),
  amount_minor integer NOT NULL CHECK(amount_minor > 0),
  currency text NOT NULL CHECK(currency='GBP'),
  provider_status text NOT NULL CHECK(provider_status='paid_out'),
  accounting_reconciled boolean NOT NULL DEFAULT false CHECK(NOT accounting_reconciled),
  evidence jsonb NOT NULL,
  FOREIGN KEY(adoption_id,tenant_id,member_id) REFERENCES public.bnms_dd_beta_adoption(id,tenant_id,member_id)
);
DO $$ DECLARE t text; r text; BEGIN
  FOREACH t IN ARRAY ARRAY['bnms_dd_beta_schema_revision','bnms_dd_beta_batch','bnms_dd_beta_adoption','bnms_dd_beta_provider_history'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);
    EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC',t);
    FOREACH r IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
      IF EXISTS(SELECT FROM pg_roles WHERE rolname=r) THEN
        EXECUTE format('REVOKE ALL ON public.%I FROM %I',t,r);
        IF r='service_role' THEN EXECUTE format('GRANT SELECT ON public.%I TO %I',t,r); END IF;
      END IF;
    END LOOP;
    EXECUTE format('CREATE TRIGGER beta_immutable BEFORE UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.bnms_dd_reject_history_mutation()',t);
  END LOOP;
END $$;
CREATE FUNCTION public.bnms_dd_beta_protect_payment() RETURNS trigger LANGUAGE plpgsql
SET search_path=public AS $$ BEGIN
  IF EXISTS(SELECT FROM bnms_dd_beta_provider_history WHERE provider_payment_id=NEW.gocardless_payment_id) THEN
    RAISE EXCEPTION 'Historical beta provider evidence must not activate or account through mutable payments';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER bnms_dd_beta_no_historical_replay BEFORE INSERT OR UPDATE ON public.gocardless_payments
FOR EACH ROW EXECUTE FUNCTION public.bnms_dd_beta_protect_payment();
CREATE FUNCTION public.bnms_dd_beta_hold_guard() RETURNS trigger LANGUAGE plpgsql
SET search_path=public AS $$ BEGIN
  IF TG_TABLE_NAME='membership_payment_plans' THEN
    IF EXISTS(SELECT FROM bnms_dd_beta_adoption WHERE plan_id=OLD.id)
      AND (NEW.collection_stopped_at IS NULL OR NEW.metadata->>'bnms_release_required' IS DISTINCT FROM 'true'
        OR (to_jsonb(NEW)-'metadata'-'updated_at') IS DISTINCT FROM (to_jsonb(OLD)-'metadata'-'updated_at')
        OR (SELECT jsonb_object_agg(k,NEW.metadata->k) FROM unnest(ARRAY['collection_mode','dynamic_first_date','agreement_id','bnms_release_required','bnms_beta_held']) k)
          IS DISTINCT FROM (SELECT jsonb_object_agg(k,OLD.metadata->k) FROM unnest(ARRAY['collection_mode','dynamic_first_date','agreement_id','bnms_release_required','bnms_beta_held']) k)) THEN
      RAISE EXCEPTION 'Beta collection release requires a separate reviewed release migration';
    END IF;
  ELSE
    IF EXISTS(SELECT FROM bnms_dd_beta_adoption WHERE plan_id=NEW.plan_id) THEN
      RAISE EXCEPTION 'Beta plans are held; collection reservation forbidden';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER bnms_dd_beta_plan_hold BEFORE UPDATE ON public.membership_payment_plans
FOR EACH ROW EXECUTE FUNCTION public.bnms_dd_beta_hold_guard();
CREATE TRIGGER bnms_dd_beta_reservation_hold BEFORE INSERT OR UPDATE ON public.gocardless_collection_reservations
FOR EACH ROW EXECUTE FUNCTION public.bnms_dd_beta_hold_guard();
CREATE FUNCTION public.bnms_dd_beta_canonical_guard() RETURNS trigger LANGUAGE plpgsql
SET search_path=public AS $$ BEGIN
  IF TG_TABLE_NAME='membership_billing_agreements' THEN
    IF EXISTS(SELECT FROM bnms_dd_beta_adoption WHERE agreement_id=OLD.id) AND (
      (to_jsonb(NEW)-'metadata'-'updated_at'-'needs_attention'-'attention_reason')
        IS DISTINCT FROM (to_jsonb(OLD)-'metadata'-'updated_at'-'needs_attention'-'attention_reason')
      OR NEW.metadata->'dd' IS DISTINCT FROM OLD.metadata->'dd'
      OR NEW.metadata->'commitment' IS DISTINCT FROM OLD.metadata->'commitment'
      OR NEW.metadata->'bnms_beta_approval' IS DISTINCT FROM OLD.metadata->'bnms_beta_approval'
      OR NEW.metadata->'gocardless_initial_payment' IS DISTINCT FROM OLD.metadata->'gocardless_initial_payment'
    ) THEN RAISE EXCEPTION 'Held beta agreement identity and consent are immutable until reviewed release'; END IF;
  ELSE
    IF EXISTS(SELECT FROM bnms_dd_beta_adoption WHERE history_id=OLD.id)
      AND (to_jsonb(NEW)-'updated_at'-'notes') IS DISTINCT FROM (to_jsonb(OLD)-'updated_at'-'notes') THEN
      RAISE EXCEPTION 'Held beta membership cannot activate or change its financial or dated terms';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER bnms_dd_beta_agreement_hold BEFORE UPDATE ON public.membership_billing_agreements
FOR EACH ROW EXECUTE FUNCTION public.bnms_dd_beta_canonical_guard();
CREATE TRIGGER bnms_dd_beta_history_hold BEFORE UPDATE ON public.member_membership_history
FOR EACH ROW EXECUTE FUNCTION public.bnms_dd_beta_canonical_guard();
CREATE FUNCTION public.bnms_dd_beta_verify_complete() RETURNS trigger LANGUAGE plpgsql
SET search_path=public AS $$
DECLARE batch uuid; a record; expected jsonb;
BEGIN
  IF TG_TABLE_NAME='bnms_dd_beta_batch' THEN batch:=NEW.id;
  ELSIF TG_TABLE_NAME='bnms_dd_beta_adoption' THEN batch:=NEW.batch_id;
  ELSE SELECT batch_id INTO batch FROM bnms_dd_beta_adoption WHERE id=NEW.adoption_id; END IF;
  IF (SELECT count(*) FROM bnms_dd_beta_adoption WHERE batch_id=batch)<>10 THEN
    RAISE EXCEPTION 'Beta batch must atomically contain ten adoptions';
  END IF;
  FOR a IN SELECT * FROM bnms_dd_beta_adoption WHERE batch_id=batch LOOP
    IF NOT EXISTS(
      SELECT FROM membership_billing_agreements b JOIN membership_payment_plans p ON p.billing_agreement_id=b.id
      JOIN member_membership_history h ON h.billing_agreement_id=b.id JOIN member m ON m.id=a.member_id
      WHERE b.id=a.agreement_id AND p.id=a.plan_id AND h.id=a.history_id
        AND b.tenant_id=a.tenant_id AND p.tenant_id=a.tenant_id AND h.tenant_id=a.tenant_id AND m.tenant_id=a.tenant_id
        AND b.member_id=a.member_id AND p.member_id=a.member_id AND h.member_id=a.member_id
        AND b.gocardless_mandate_id=a.mandate_id AND p.gocardless_mandate_id=a.mandate_id
        AND b.gocardless_customer_id=a.customer_id AND b.environment='live' AND p.environment='live'
        AND p.collection_stopped_at IS NOT NULL AND p.metadata->>'bnms_release_required'='true'
        AND b.status='first_payment_pending' AND p.status='first_payment_pending'
        AND h.payment_status='unpaid' AND h.status='pending_payment_setup'
    ) THEN RAISE EXCEPTION 'Beta adoption owner or held canonical state mismatch'; END IF;
    expected:=a.evidence->'history';
    IF jsonb_typeof(expected) IS DISTINCT FROM 'array' OR jsonb_array_length(expected)=0
      OR (SELECT count(*) FROM bnms_dd_beta_provider_history WHERE adoption_id=a.id)<>jsonb_array_length(expected)
      OR EXISTS(SELECT FROM bnms_dd_beta_provider_history h WHERE h.adoption_id=a.id AND (
        h.evidence->>'id' IS DISTINCT FROM h.provider_payment_id
        OR h.evidence->'links'->>'mandate' IS DISTINCT FROM a.mandate_id
        OR h.evidence->>'status' IS DISTINCT FROM 'paid_out'
        OR (h.evidence->>'amount')::integer IS DISTINCT FROM h.amount_minor
        OR h.evidence->>'currency' IS DISTINCT FROM h.currency
        OR (h.evidence->>'charge_date')::date IS DISTINCT FROM h.charge_date
        OR NOT EXISTS(SELECT FROM jsonb_array_elements(expected) e WHERE e->'evidence'=h.evidence)
      )) THEN RAISE EXCEPTION 'Beta historical provider evidence incomplete or conflicting'; END IF;
  END LOOP;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER beta_complete AFTER INSERT ON public.bnms_dd_beta_batch
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.bnms_dd_beta_verify_complete();
CREATE CONSTRAINT TRIGGER beta_complete AFTER INSERT ON public.bnms_dd_beta_adoption
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.bnms_dd_beta_verify_complete();
CREATE CONSTRAINT TRIGGER beta_complete AFTER INSERT ON public.bnms_dd_beta_provider_history
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.bnms_dd_beta_verify_complete();