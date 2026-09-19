-- Pilot-only approval/provenance; no operational records or provider actions.
CREATE TABLE IF NOT EXISTS public.bnms_dd_pilot_adoption (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL CHECK (tenant_id='ff2df806-b321-4254-b651-3af11fccf1db'),
  member_id uuid NOT NULL UNIQUE REFERENCES public.member(id)
    CHECK (member_id='33e5d54d-162e-436d-9bff-ec6676d198f9'),
  historical_import_id uuid NOT NULL UNIQUE REFERENCES public.bnms_dd_pilot_import(id),
  agreement_id uuid NOT NULL UNIQUE REFERENCES public.membership_billing_agreements(id),
  plan_id uuid NOT NULL UNIQUE REFERENCES public.membership_payment_plans(id),
  history_id uuid NOT NULL UNIQUE REFERENCES public.member_membership_history(id),
  evidence_sha256 text NOT NULL CHECK(evidence_sha256 ~ '^[0-9a-f]{64}$'),
  evidence jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.bnms_dd_pilot_adoption ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.bnms_dd_pilot_adoption FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS(SELECT FROM pg_roles WHERE rolname='anon') THEN
    REVOKE ALL ON public.bnms_dd_pilot_adoption FROM anon;
  END IF;
  IF EXISTS(SELECT FROM pg_roles WHERE rolname='authenticated') THEN
    REVOKE ALL ON public.bnms_dd_pilot_adoption FROM authenticated;
  END IF;
  IF EXISTS(SELECT FROM pg_roles WHERE rolname='service_role') THEN
    REVOKE ALL ON public.bnms_dd_pilot_adoption FROM service_role;
    GRANT SELECT ON public.bnms_dd_pilot_adoption TO service_role;
  END IF;
END $$;
DROP TRIGGER IF EXISTS bnms_dd_adoption_immutable ON public.bnms_dd_pilot_adoption;
CREATE TRIGGER bnms_dd_adoption_immutable BEFORE UPDATE OR DELETE ON public.bnms_dd_pilot_adoption
FOR EACH ROW EXECUTE FUNCTION public.bnms_dd_reject_history_mutation();