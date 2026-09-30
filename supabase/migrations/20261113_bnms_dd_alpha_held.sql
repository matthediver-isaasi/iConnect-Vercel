-- Alpha only. Each member's held adoption + full Jan-2026 invoice history is
-- atomic. There is deliberately no release RPC or service-role write grant.
CREATE TABLE public.bnms_dd_alpha_adoption (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL CHECK(tenant_id='ff2df806-b321-4254-b651-3af11fccf1db'),
  member_id uuid NOT NULL UNIQUE REFERENCES public.member(id)
    CHECK(member_id<>'33e5d54d-162e-436d-9bff-ec6676d198f9'),
  mandate_id text NOT NULL UNIQUE CHECK(mandate_id<>'MD00330XE0B797'),
  customer_id text NOT NULL UNIQUE CHECK(customer_id<>'CU00426EF15CE5'),
  agreement_id uuid NOT NULL UNIQUE REFERENCES public.membership_billing_agreements(id),
  plan_id uuid NOT NULL UNIQUE REFERENCES public.membership_payment_plans(id),
  history_id uuid NOT NULL UNIQUE REFERENCES public.member_membership_history(id),
  evidence_sha256 text NOT NULL CHECK(evidence_sha256 ~ '^[0-9a-f]{64}$'),
  manifest_sha256 text NOT NULL CHECK(manifest_sha256 ~ '^[0-9a-f]{64}$'),
  evidence jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(id,tenant_id,member_id)
);
CREATE TABLE public.bnms_dd_alpha_provider_history (
  id uuid PRIMARY KEY, adoption_id uuid NOT NULL,
  tenant_id uuid NOT NULL, member_id uuid NOT NULL,
  provider_payment_id text NOT NULL UNIQUE,
  charge_date date NOT NULL CHECK(charge_date>='2026-01-01' AND charge_date<'2026-10-01'),
  amount_minor integer NOT NULL CHECK(amount_minor>0),
  currency text NOT NULL CHECK(currency='GBP'),
  provider_status text NOT NULL CHECK(provider_status='paid_out'),
  evidence jsonb NOT NULL,
  UNIQUE(id,tenant_id,member_id,provider_payment_id),
  FOREIGN KEY(adoption_id,tenant_id,member_id) REFERENCES public.bnms_dd_alpha_adoption(id,tenant_id,member_id)
);
CREATE TABLE public.bnms_dd_alpha_invoice_link (
  history_id uuid PRIMARY KEY, tenant_id uuid NOT NULL, member_id uuid NOT NULL,
  provider_payment_id text NOT NULL UNIQUE,
  xero_tenant_id uuid NOT NULL CHECK(xero_tenant_id='3d57dce6-2205-462f-abf6-9c7cbf00be23'),
  xero_contact_id uuid NOT NULL, xero_invoice_id uuid NOT NULL UNIQUE,
  xero_invoice_number text NOT NULL, xero_payment_id uuid NOT NULL UNIQUE,
  evidence_sha256 text NOT NULL CHECK(evidence_sha256 ~ '^[0-9a-f]{64}$'),
  evidence jsonb NOT NULL,
  FOREIGN KEY(history_id,tenant_id,member_id,provider_payment_id)
    REFERENCES public.bnms_dd_alpha_provider_history(id,tenant_id,member_id,provider_payment_id)
);
DO $$ DECLARE t text; r text; BEGIN
  FOREACH t IN ARRAY ARRAY['bnms_dd_alpha_adoption','bnms_dd_alpha_provider_history','bnms_dd_alpha_invoice_link'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);
    EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC',t);
    FOREACH r IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
      IF EXISTS(SELECT FROM pg_roles WHERE rolname=r) THEN
        EXECUTE format('REVOKE ALL ON public.%I FROM %I',t,r);
        IF r='service_role' THEN EXECUTE format('GRANT SELECT ON public.%I TO %I',t,r); END IF;
      END IF;
    END LOOP;
    EXECUTE format('CREATE TRIGGER alpha_immutable BEFORE UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.bnms_dd_reject_history_mutation()',t);
  END LOOP;
END $$;
CREATE FUNCTION public.bnms_dd_alpha_hold_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=public AS $$
BEGIN
  IF TG_TABLE_NAME='gocardless_payments' THEN
    IF EXISTS(SELECT FROM bnms_dd_alpha_provider_history WHERE provider_payment_id=NEW.gocardless_payment_id)
      OR EXISTS(SELECT FROM bnms_dd_alpha_adoption WHERE mandate_id=NEW.gocardless_mandate_id) THEN
      RAISE EXCEPTION 'Alpha held mandate cannot activate through mutable payments';
    END IF;
  ELSIF TG_TABLE_NAME='gocardless_collection_reservations' THEN
    IF EXISTS(SELECT FROM bnms_dd_alpha_adoption WHERE plan_id=NEW.plan_id) THEN
      RAISE EXCEPTION 'Alpha collection release not approved';
    END IF;
  ELSIF TG_TABLE_NAME='membership_payment_plans' THEN
    IF EXISTS(SELECT FROM bnms_dd_alpha_adoption WHERE plan_id=OLD.id) THEN
      RAISE EXCEPTION 'Alpha plan is immutable until separate reviewed release';
    END IF;
  ELSIF TG_TABLE_NAME='membership_billing_agreements' THEN
    IF EXISTS(SELECT FROM bnms_dd_alpha_adoption WHERE agreement_id=OLD.id) THEN
      RAISE EXCEPTION 'Alpha agreement is immutable until separate reviewed release';
    END IF;
  ELSIF TG_TABLE_NAME='member_membership_history' THEN
    IF EXISTS(SELECT FROM bnms_dd_alpha_adoption WHERE history_id=OLD.id) THEN
      RAISE EXCEPTION 'Alpha membership cannot activate or change';
    END IF;
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER bnms_dd_alpha_no_historical_replay BEFORE INSERT OR UPDATE ON public.gocardless_payments
FOR EACH ROW EXECUTE FUNCTION public.bnms_dd_alpha_hold_guard();
CREATE TRIGGER bnms_dd_alpha_reservation_hold BEFORE INSERT OR UPDATE ON public.gocardless_collection_reservations
FOR EACH ROW EXECUTE FUNCTION public.bnms_dd_alpha_hold_guard();
CREATE TRIGGER bnms_dd_alpha_plan_hold BEFORE UPDATE OR DELETE ON public.membership_payment_plans
FOR EACH ROW EXECUTE FUNCTION public.bnms_dd_alpha_hold_guard();
CREATE TRIGGER bnms_dd_alpha_agreement_hold BEFORE UPDATE OR DELETE ON public.membership_billing_agreements
FOR EACH ROW EXECUTE FUNCTION public.bnms_dd_alpha_hold_guard();
CREATE TRIGGER bnms_dd_alpha_history_hold BEFORE UPDATE OR DELETE ON public.member_membership_history
FOR EACH ROW EXECUTE FUNCTION public.bnms_dd_alpha_hold_guard();
CREATE FUNCTION public.bnms_dd_alpha_verify_complete() RETURNS trigger LANGUAGE plpgsql SET search_path=public AS $$
DECLARE a public.bnms_dd_alpha_adoption; expected jsonb; expected_links jsonb;
BEGIN
  IF TG_TABLE_NAME='bnms_dd_alpha_adoption' THEN a:=NEW;
  ELSIF TG_TABLE_NAME='bnms_dd_alpha_provider_history' THEN SELECT * INTO a FROM bnms_dd_alpha_adoption WHERE id=NEW.adoption_id;
  ELSE SELECT x.* INTO a FROM bnms_dd_alpha_adoption x JOIN bnms_dd_alpha_provider_history h ON h.adoption_id=x.id WHERE h.id=NEW.history_id;
  END IF;
  IF EXISTS(SELECT FROM bnms_dd_beta_adoption WHERE member_id=a.member_id OR mandate_id=a.mandate_id OR customer_id=a.customer_id)
    OR EXISTS(SELECT FROM bnms_dd_historical_payment p JOIN bnms_dd_alpha_provider_history h
      ON p.provider_payment_id=h.provider_payment_id WHERE h.adoption_id=a.id) THEN
    RAISE EXCEPTION 'Original pilot and beta evidence excluded';
  END IF;
  IF NOT EXISTS(
    SELECT FROM membership_billing_agreements b JOIN membership_payment_plans p ON p.billing_agreement_id=b.id
    JOIN member_membership_history h ON h.billing_agreement_id=b.id JOIN member m ON m.id=a.member_id
    WHERE b.id=a.agreement_id AND p.id=a.plan_id AND h.id=a.history_id
      AND b.tenant_id=a.tenant_id AND p.tenant_id=a.tenant_id AND h.tenant_id=a.tenant_id AND m.tenant_id=a.tenant_id
      AND b.member_id=a.member_id AND p.member_id=a.member_id AND h.member_id=a.member_id
      AND b.gocardless_mandate_id=a.mandate_id AND p.gocardless_mandate_id=a.mandate_id
      AND b.gocardless_customer_id=a.customer_id AND b.environment='live' AND p.environment='live'
      AND b.status='first_payment_pending' AND p.status='first_payment_pending'
      AND h.status='pending_payment_setup' AND h.payment_status='unpaid'
      AND b.term_start_date='2026-10-01' AND b.term_end_date='2027-09-30'
      AND h.term_start_date=b.term_start_date AND h.term_end_date=b.term_end_date
      AND p.start_date='2026-10-01' AND p.day_of_month=1 AND p.interval_unit='monthly'
      AND p.collection_stopped_at IS NOT NULL AND p.metadata->>'bnms_release_required'='true'
      AND p.metadata->>'bnms_alpha_held'='true' AND p.metadata->>'collection_mode'='dynamic'
      AND b.metadata->'dd'->>'activation_rule'='first_payment'
      AND b.metadata->'dd'->'collection_policy'->>'end_policy'='continue'
      AND b.metadata->'dd'->'collection_policy'->>'pricing_policy'='dynamic'
      AND b.metadata->'dd'->>'plan_total' IS NULL
      AND h.final_cost IS NULL AND h.vat_amount IS NULL AND h.total_with_vat IS NULL
  ) THEN RAISE EXCEPTION 'Alpha canonical owner, terms or hold mismatch'; END IF;
  expected:=a.evidence->'history'; expected_links:=a.evidence->'links';
  IF jsonb_typeof(expected) IS DISTINCT FROM 'array' OR jsonb_array_length(expected)=0
    OR jsonb_typeof(expected_links) IS DISTINCT FROM 'array'
    OR jsonb_array_length(expected)<>jsonb_array_length(expected_links)
    OR (SELECT count(*) FROM bnms_dd_alpha_provider_history WHERE adoption_id=a.id)<>jsonb_array_length(expected)
    OR (SELECT count(*) FROM bnms_dd_alpha_invoice_link l JOIN bnms_dd_alpha_provider_history h ON h.id=l.history_id
      WHERE h.adoption_id=a.id)<>jsonb_array_length(expected)
    OR EXISTS(SELECT FROM bnms_dd_alpha_provider_history h WHERE h.adoption_id=a.id AND (
      h.evidence->>'id' IS DISTINCT FROM h.provider_payment_id
      OR h.evidence->'links'->>'mandate' IS DISTINCT FROM a.mandate_id
      OR h.evidence->>'status' IS DISTINCT FROM 'paid_out'
      OR (h.evidence->>'amount')::integer IS DISTINCT FROM h.amount_minor
      OR h.evidence->>'currency' IS DISTINCT FROM h.currency
      OR (h.evidence->>'charge_date')::date IS DISTINCT FROM h.charge_date
      OR NOT EXISTS(SELECT FROM jsonb_array_elements(expected) e WHERE e->'evidence'=h.evidence AND e->>'id'=h.id::text)
    ))
    OR EXISTS(SELECT FROM bnms_dd_alpha_invoice_link l JOIN bnms_dd_alpha_provider_history h ON h.id=l.history_id
      WHERE h.adoption_id=a.id AND NOT EXISTS(SELECT FROM jsonb_array_elements(expected_links) e
        WHERE e=to_jsonb(l)))
    THEN RAISE EXCEPTION 'Alpha full historical invoice coverage/evidence required'; END IF;
  IF EXISTS(SELECT FROM bnms_dd_alpha_invoice_link l JOIN bnms_dd_beta_invoice_link b
    ON l.xero_invoice_id=b.xero_invoice_id OR l.xero_payment_id=b.xero_payment_id
    JOIN bnms_dd_alpha_provider_history h ON h.id=l.history_id WHERE h.adoption_id=a.id)
    OR EXISTS(SELECT FROM bnms_dd_alpha_invoice_link l JOIN bnms_dd_alpha_invoice_link other
      ON l.xero_contact_id=other.xero_contact_id AND l.member_id<>other.member_id
      JOIN bnms_dd_alpha_provider_history h ON h.id=l.history_id WHERE h.adoption_id=a.id)
    THEN RAISE EXCEPTION 'Alpha invoice/contact already claimed'; END IF;
  IF EXISTS(SELECT FROM bnms_dd_alpha_provider_history h JOIN gocardless_payments p
    ON p.gocardless_payment_id=h.provider_payment_id OR p.gocardless_mandate_id=a.mandate_id
    WHERE h.adoption_id=a.id)
    OR EXISTS(SELECT FROM gocardless_collection_reservations WHERE plan_id=a.plan_id)
    THEN RAISE EXCEPTION 'Alpha mutable payment or collection reservation collision'; END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER alpha_complete AFTER INSERT ON public.bnms_dd_alpha_adoption
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.bnms_dd_alpha_verify_complete();
CREATE CONSTRAINT TRIGGER alpha_complete AFTER INSERT ON public.bnms_dd_alpha_provider_history
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.bnms_dd_alpha_verify_complete();
CREATE CONSTRAINT TRIGGER alpha_complete AFTER INSERT ON public.bnms_dd_alpha_invoice_link
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.bnms_dd_alpha_verify_complete();