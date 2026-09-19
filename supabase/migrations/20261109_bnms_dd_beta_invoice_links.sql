-- Append-only accounting provenance; never rewrite provider evidence or release plans.
CREATE TABLE public.bnms_dd_beta_invoice_link (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  history_id uuid NOT NULL UNIQUE REFERENCES public.bnms_dd_beta_provider_history(id),
  tenant_id uuid NOT NULL CHECK(tenant_id='ff2df806-b321-4254-b651-3af11fccf1db'),
  member_id uuid NOT NULL REFERENCES public.member(id)
    CHECK(member_id<>'33e5d54d-162e-436d-9bff-ec6676d198f9'),
  provider_payment_id text NOT NULL UNIQUE,
  xero_tenant_id uuid NOT NULL CHECK(xero_tenant_id='3d57dce6-2205-462f-abf6-9c7cbf00be23'),
  xero_contact_id uuid NOT NULL,
  xero_invoice_id uuid NOT NULL UNIQUE,
  xero_invoice_number text NOT NULL CHECK(length(xero_invoice_number)>0),
  xero_payment_id uuid NOT NULL UNIQUE,
  evidence_sha256 text NOT NULL CHECK(evidence_sha256 ~ '^[0-9a-f]{64}$'),
  manifest_sha256 text NOT NULL CHECK(manifest_sha256 ~ '^[0-9a-f]{64}$'),
  evidence jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE FUNCTION public.bnms_dd_beta_invoice_owner_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=public AS $$
BEGIN
  IF NOT EXISTS(
    SELECT FROM bnms_dd_beta_provider_history h JOIN bnms_dd_beta_adoption a ON a.id=h.adoption_id
    JOIN bnms_dd_beta_batch b ON b.id=a.batch_id
    WHERE h.id=NEW.history_id AND h.tenant_id=NEW.tenant_id AND h.member_id=NEW.member_id
      AND h.provider_payment_id=NEW.provider_payment_id
      AND b.evidence_sha256='aaeb5efa50de77db5b6213c23d32a71ae0aa19d88484f1afd911f49fa44739c2'
      AND NEW.evidence->'providerPayment'->>'id'=h.provider_payment_id
      AND NEW.evidence->'providerPayment'->'links'->>'mandate'=a.mandate_id
      AND NEW.evidence->'customer'->>'id'=a.customer_id
      AND NEW.evidence->'mandate'->'links'->>'customer'=a.customer_id
      AND NEW.evidence->'invoice'->>'InvoiceID'=NEW.xero_invoice_id::text
      AND NEW.evidence->'invoice'->>'InvoiceNumber'=NEW.xero_invoice_number
      AND NEW.evidence->'invoice'->'Contact'->>'ContactID'=NEW.xero_contact_id::text
      AND NEW.evidence->'contact'->>'ContactID'=NEW.xero_contact_id::text
      AND NEW.evidence->'invoice'->'Payments'->0->>'PaymentID'=NEW.xero_payment_id::text
      AND NEW.evidence->'invoice'->'Payments'->0->>'Reference'=NEW.provider_payment_id
  ) THEN RAISE EXCEPTION 'Historical invoice ownership/evidence mismatch'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER beta_invoice_owner BEFORE INSERT ON public.bnms_dd_beta_invoice_link
  FOR EACH ROW EXECUTE FUNCTION public.bnms_dd_beta_invoice_owner_guard();
CREATE TRIGGER beta_invoice_immutable BEFORE UPDATE OR DELETE ON public.bnms_dd_beta_invoice_link
  FOR EACH ROW EXECUTE FUNCTION public.bnms_dd_reject_history_mutation();
ALTER TABLE public.bnms_dd_beta_invoice_link ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.bnms_dd_beta_invoice_link FROM PUBLIC;
DO $$ DECLARE r text; BEGIN
  FOREACH r IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
    IF EXISTS(SELECT FROM pg_roles WHERE rolname=r) THEN
      EXECUTE format('REVOKE ALL ON public.bnms_dd_beta_invoice_link FROM %I',r);
      IF r='service_role' THEN GRANT SELECT ON public.bnms_dd_beta_invoice_link TO service_role; END IF;
    END IF;
  END LOOP;
END $$;