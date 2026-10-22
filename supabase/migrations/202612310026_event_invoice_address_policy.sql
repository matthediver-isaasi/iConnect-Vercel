-- Private immutable pre-Stripe purchaser/address instructions. No backfill.
BEGIN;
CREATE TABLE IF NOT EXISTS public.event_invoice_address_policy (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  member_id uuid NOT NULL,
  event_id uuid NOT NULL,
  source text NOT NULL CHECK (source IN ('simple', 'complex')),
  snapshot jsonb NOT NULL CHECK (snapshot->>'version' = '1'),
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.event_invoice_address_policy ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.event_invoice_address_policy FORCE ROW LEVEL SECURITY;
REVOKE ALL ON public.event_invoice_address_policy FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT ON public.event_invoice_address_policy TO service_role;
CREATE OR REPLACE FUNCTION public.guard_event_invoice_address_policy() RETURNS trigger
LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'Invoice policy is immutable'; END IF;
  IF NOT EXISTS (SELECT 1 FROM member WHERE id = NEW.member_id AND tenant_id = NEW.tenant_id)
    OR (NEW.source = 'simple' AND NOT EXISTS (SELECT 1 FROM event WHERE id = NEW.event_id AND tenant_id = NEW.tenant_id))
    OR (NEW.source = 'complex' AND NOT EXISTS (SELECT 1 FROM complex_event WHERE id = NEW.event_id AND tenant_id = NEW.tenant_id))
    OR NEW.snapshot->>'tenantId' IS DISTINCT FROM NEW.tenant_id::text
    OR NEW.snapshot->>'memberId' IS DISTINCT FROM NEW.member_id::text
    OR NEW.snapshot->>'eventId' IS DISTINCT FROM NEW.event_id::text
    OR NEW.snapshot->>'source' IS DISTINCT FROM NEW.source THEN
    RAISE EXCEPTION 'Invalid invoice policy binding';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.guard_event_invoice_address_policy() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS event_invoice_address_policy_guard ON public.event_invoice_address_policy;
CREATE TRIGGER event_invoice_address_policy_guard BEFORE INSERT OR UPDATE OR DELETE
ON public.event_invoice_address_policy FOR EACH ROW EXECUTE FUNCTION public.guard_event_invoice_address_policy();
CREATE TABLE IF NOT EXISTS public.event_invoice_payment_request (
  policy_id uuid PRIMARY KEY REFERENCES public.event_invoice_address_policy(id),
  tenant_id uuid NOT NULL,
  parameters jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS public.event_invoice_payment_binding (
  policy_id uuid PRIMARY KEY REFERENCES public.event_invoice_address_policy(id),
  tenant_id uuid NOT NULL,
  payment_intent_id text NOT NULL CHECK (payment_intent_id ~ '^pi_[A-Za-z0-9]+$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(tenant_id,payment_intent_id)
);
ALTER TABLE public.event_invoice_payment_request ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.event_invoice_payment_request FORCE ROW LEVEL SECURITY;
ALTER TABLE public.event_invoice_payment_binding ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.event_invoice_payment_binding FORCE ROW LEVEL SECURITY;
REVOKE ALL ON public.event_invoice_payment_request, public.event_invoice_payment_binding FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT ON public.event_invoice_payment_request, public.event_invoice_payment_binding TO service_role;
CREATE OR REPLACE FUNCTION public.guard_event_invoice_payment_binding() RETURNS trigger
LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'Payment invoice authority is immutable'; END IF;
  IF NOT EXISTS (SELECT 1 FROM event_invoice_address_policy WHERE id=NEW.policy_id AND tenant_id=NEW.tenant_id) THEN
    RAISE EXCEPTION 'Payment invoice authority tenant mismatch';
  END IF;
  IF TG_TABLE_NAME='event_invoice_payment_request' THEN
    IF NOT EXISTS (SELECT 1 FROM event_invoice_address_policy p WHERE p.id=NEW.policy_id
      AND NEW.parameters#>>'{metadata,event_invoice_policy_id}'=p.id::text
      AND NEW.parameters#>>'{metadata,event_invoice_member_id}'=p.member_id::text
      AND NEW.parameters#>>'{metadata,event_id}'=p.event_id::text
      AND NEW.parameters#>>'{metadata,tenant_id}'=p.tenant_id::text) THEN
      RAISE EXCEPTION 'Payment request metadata mismatch';
    END IF;
  ELSIF NOT EXISTS (SELECT 1 FROM event_invoice_payment_request WHERE policy_id=NEW.policy_id AND tenant_id=NEW.tenant_id) THEN
    RAISE EXCEPTION 'Frozen payment request required';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.guard_event_invoice_payment_binding() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS event_invoice_payment_request_guard ON public.event_invoice_payment_request;
CREATE TRIGGER event_invoice_payment_request_guard BEFORE INSERT OR UPDATE OR DELETE
ON public.event_invoice_payment_request FOR EACH ROW EXECUTE FUNCTION public.guard_event_invoice_payment_binding();
DROP TRIGGER IF EXISTS event_invoice_payment_binding_guard ON public.event_invoice_payment_binding;
CREATE TRIGGER event_invoice_payment_binding_guard BEFORE INSERT OR UPDATE OR DELETE
ON public.event_invoice_payment_binding FOR EACH ROW EXECUTE FUNCTION public.guard_event_invoice_payment_binding();
COMMIT;
