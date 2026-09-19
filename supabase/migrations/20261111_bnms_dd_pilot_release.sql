-- Separate explicit collection release, never an implicit adoption side effect.
CREATE TABLE IF NOT EXISTS public.bnms_dd_pilot_release (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  adoption_id uuid NOT NULL UNIQUE REFERENCES public.bnms_dd_pilot_adoption(id),
  tenant_id uuid NOT NULL CHECK(tenant_id='ff2df806-b321-4254-b651-3af11fccf1db'),
  member_id uuid NOT NULL UNIQUE CHECK(member_id='33e5d54d-162e-436d-9bff-ec6676d198f9'),
  evidence_sha256 text NOT NULL CHECK(evidence_sha256 ~ '^[0-9a-f]{64}$'),
  evidence jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.bnms_dd_pilot_release ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.bnms_dd_pilot_release FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS(SELECT FROM pg_roles WHERE rolname='anon') THEN REVOKE ALL ON public.bnms_dd_pilot_release FROM anon; END IF;
  IF EXISTS(SELECT FROM pg_roles WHERE rolname='authenticated') THEN REVOKE ALL ON public.bnms_dd_pilot_release FROM authenticated; END IF;
  IF EXISTS(SELECT FROM pg_roles WHERE rolname='service_role') THEN
    REVOKE ALL ON public.bnms_dd_pilot_release FROM service_role;
    GRANT SELECT ON public.bnms_dd_pilot_release TO service_role;
  END IF;
END $$;
DROP TRIGGER IF EXISTS bnms_dd_release_immutable ON public.bnms_dd_pilot_release;
CREATE TRIGGER bnms_dd_release_immutable BEFORE UPDATE OR DELETE ON public.bnms_dd_pilot_release
FOR EACH ROW EXECUTE FUNCTION public.bnms_dd_reject_history_mutation();
CREATE OR REPLACE FUNCTION public.bnms_dd_guard_initial_reservation() RETURNS trigger
LANGUAGE plpgsql SET search_path=public AS $$
DECLARE pilot public.bnms_dd_pilot_adoption;
BEGIN
  SELECT * INTO pilot FROM bnms_dd_pilot_adoption WHERE plan_id=NEW.plan_id;
  IF NOT FOUND THEN RETURN NEW; END IF;
  IF NEW.tenant_id IS DISTINCT FROM pilot.tenant_id
    OR NOT EXISTS(SELECT FROM bnms_dd_pilot_release WHERE adoption_id=pilot.id
      AND tenant_id=pilot.tenant_id AND member_id=pilot.member_id) THEN
    RAISE EXCEPTION 'BNMS pilot collection has not been explicitly released';
  END IF;
  IF NEW.collection_number=1 AND (NEW.due_date IS DISTINCT FROM '2026-10-01'::date
    OR NEW.requested_charge_date IS DISTINCT FROM '2026-10-01'::date
    OR NEW.amount_minor IS DISTINCT FROM 1300 OR NEW.currency IS DISTINCT FROM 'GBP') THEN
    RAISE EXCEPTION 'BNMS pilot first collection must be exactly October 1 GBP13; review drift';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS bnms_dd_initial_reservation_guard ON public.gocardless_collection_reservations;
CREATE TRIGGER bnms_dd_initial_reservation_guard BEFORE INSERT ON public.gocardless_collection_reservations
FOR EACH ROW EXECUTE FUNCTION public.bnms_dd_guard_initial_reservation();