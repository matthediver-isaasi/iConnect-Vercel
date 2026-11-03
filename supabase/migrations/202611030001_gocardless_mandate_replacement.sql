-- Preparation only: no existing agreement, plan, payment or mandate is changed.
BEGIN;
CREATE TABLE public.membership_mandate_replacements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  member_id uuid NOT NULL,
  agreement_id uuid NOT NULL REFERENCES public.membership_billing_agreements(id),
  history_id uuid NOT NULL REFERENCES public.member_membership_history(id),
  environment text NOT NULL CHECK (environment IN ('sandbox','live')),
  provider_context jsonb NOT NULL,
  old_mandate_id text NOT NULL,
  old_customer_id text,
  billing_request_id text UNIQUE,
  flow_id text,
  authorization_url text,
  new_mandate_id text,
  new_customer_id text,
  status text NOT NULL DEFAULT 'authorizing'
    CHECK (status IN ('authorizing','awaiting_confirmation','switching','action_required','cancelled','completed')),
  phase text NOT NULL DEFAULT 'authorization' CHECK (phase IN
    ('authorization','prepared','stop_intent','create_intent','verify_successor','commit_intent','retire_intent','complete')),
  snapshot jsonb,
  new_subscription_id text UNIQUE,
  completed_at timestamptz,
  reason text,
  version integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX membership_mandate_replacement_open_member
  ON public.membership_mandate_replacements(tenant_id,member_id)
  WHERE status NOT IN ('cancelled','completed');
CREATE UNIQUE INDEX membership_mandate_replacement_open_mandate
  ON public.membership_mandate_replacements(environment,old_mandate_id)
  WHERE status NOT IN ('cancelled','completed');
ALTER TABLE public.membership_mandate_replacements ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.membership_mandate_replacements FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE ON public.membership_mandate_replacements TO service_role;

CREATE FUNCTION public.guard_membership_mandate_replacement()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE a public.membership_billing_agreements; h public.member_membership_history;
BEGIN
  IF TG_OP='INSERT' THEN
    SELECT * INTO a FROM public.membership_billing_agreements WHERE id=NEW.agreement_id FOR SHARE;
    SELECT * INTO h FROM public.member_membership_history WHERE id=NEW.history_id FOR SHARE;
    IF a.id IS NULL OR h.id IS NULL
      OR a.tenant_id IS DISTINCT FROM NEW.tenant_id OR a.member_id IS DISTINCT FROM NEW.member_id
      OR h.tenant_id IS DISTINCT FROM NEW.tenant_id OR h.member_id IS DISTINCT FROM NEW.member_id
      OR h.billing_agreement_id IS DISTINCT FROM a.id OR a.organization_id IS NOT NULL
      OR a.provider IS DISTINCT FROM 'gocardless' OR a.agreement_type IS DISTINCT FROM 'member'
      OR a.environment IS DISTINCT FROM NEW.environment
      OR a.gocardless_mandate_id IS DISTINCT FROM NEW.old_mandate_id
      OR a.gocardless_customer_id IS DISTINCT FROM NEW.old_customer_id THEN
      RAISE EXCEPTION 'Replacement ownership mismatch';
    END IF;
    IF NEW.status <> 'authorizing' OR NEW.new_mandate_id IS NOT NULL
      OR NEW.billing_request_id IS NOT NULL THEN RAISE EXCEPTION 'Invalid initial replacement'; END IF;
  ELSE
    IF ROW(NEW.id,NEW.tenant_id,NEW.member_id,NEW.agreement_id,NEW.history_id,
      NEW.environment,NEW.provider_context,NEW.old_mandate_id,NEW.old_customer_id,NEW.created_at)
      IS DISTINCT FROM ROW(OLD.id,OLD.tenant_id,OLD.member_id,OLD.agreement_id,OLD.history_id,
      OLD.environment,OLD.provider_context,OLD.old_mandate_id,OLD.old_customer_id,OLD.created_at) THEN
      RAISE EXCEPTION 'Replacement origin is immutable';
    END IF;
    IF (OLD.billing_request_id IS NOT NULL AND NEW.billing_request_id IS DISTINCT FROM OLD.billing_request_id)
      OR (OLD.flow_id IS NOT NULL AND NEW.flow_id IS DISTINCT FROM OLD.flow_id)
      OR (OLD.authorization_url IS NOT NULL AND NEW.authorization_url IS DISTINCT FROM OLD.authorization_url)
      OR (OLD.new_mandate_id IS NOT NULL AND NEW.new_mandate_id IS DISTINCT FROM OLD.new_mandate_id)
      OR (OLD.new_customer_id IS NOT NULL AND NEW.new_customer_id IS DISTINCT FROM OLD.new_customer_id) THEN
      RAISE EXCEPTION 'Replacement provider identity is immutable';
    END IF;
    IF OLD.snapshot IS NOT NULL AND NEW.snapshot IS DISTINCT FROM OLD.snapshot THEN
      RAISE EXCEPTION 'Handover snapshot is immutable';
    END IF;
    IF OLD.new_subscription_id IS NOT NULL AND NEW.new_subscription_id IS DISTINCT FROM OLD.new_subscription_id THEN
      RAISE EXCEPTION 'Successor subscription is immutable';
    END IF;
    IF NEW.status='completed' AND (NEW.phase <> 'complete' OR OLD.phase <> 'retire_intent'
      OR NEW.completed_at IS NULL OR NEW.new_mandate_id IS NULL) THEN
      RAISE EXCEPTION 'Verified retirement is required';
    END IF;
    IF OLD.status IN ('action_required','cancelled','completed') AND NEW.status<>OLD.status THEN
      RAISE EXCEPTION 'Replacement requires reviewed resolution';
    END IF;
    NEW.version := OLD.version + 1;
    NEW.updated_at := now();
  END IF;
  IF NEW.new_mandate_id=NEW.old_mandate_id THEN RAISE EXCEPTION 'Replacement mandate must be distinct'; END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.guard_membership_mandate_replacement() FROM PUBLIC,anon,authenticated;
CREATE TRIGGER guard_membership_mandate_replacement
BEFORE INSERT OR UPDATE ON public.membership_mandate_replacements
FOR EACH ROW EXECUTE FUNCTION public.guard_membership_mandate_replacement();
COMMIT;
