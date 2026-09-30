-- Pilot only. Preserves the original immutable release/adoption evidence.
-- Deploy this guard BEFORE the updated worker. The old worker then fails closed
-- before Oct 1, and continues to fail closed on its old exact-date rule after it.
-- Apply transactionally; refuse an in-flight reservation requiring reconciliation.
LOCK TABLE public.gocardless_collection_reservations IN SHARE ROW EXCLUSIVE MODE;
DO $$
BEGIN
  IF EXISTS (
    SELECT FROM public.gocardless_collection_reservations r
    JOIN public.bnms_dd_pilot_adoption a ON a.plan_id=r.plan_id
    WHERE a.tenant_id='ff2df806-b321-4254-b651-3af11fccf1db'
      AND a.member_id='33e5d54d-162e-436d-9bff-ec6676d198f9'
  ) THEN
    RAISE EXCEPTION 'Pilot reservations already exist; reconcile before processing-policy migration';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.bnms_dd_guard_initial_reservation() RETURNS trigger
LANGUAGE plpgsql SET search_path=public AS $$
DECLARE pilot public.bnms_dd_pilot_adoption;
BEGIN
  SELECT * INTO pilot FROM bnms_dd_pilot_adoption WHERE plan_id=NEW.plan_id;
  IF NOT FOUND THEN RETURN NEW; END IF;
  IF pilot.tenant_id IS DISTINCT FROM 'ff2df806-b321-4254-b651-3af11fccf1db'::uuid
    OR pilot.member_id IS DISTINCT FROM '33e5d54d-162e-436d-9bff-ec6676d198f9'::uuid
    OR NEW.tenant_id IS DISTINCT FROM pilot.tenant_id
    OR NOT EXISTS(SELECT FROM bnms_dd_pilot_release WHERE adoption_id=pilot.id
      AND tenant_id=pilot.tenant_id AND member_id=pilot.member_id) THEN
    RAISE EXCEPTION 'BNMS pilot collection has not been explicitly released';
  END IF;
  -- 2026-10-01 00:00 Europe/London = 2026-09-30 23:00 UTC.
  IF clock_timestamp() < TIMESTAMPTZ '2026-10-01 00:00:00 Europe/London' THEN
    RAISE EXCEPTION 'BNMS pilot processing-not-before October 1 Europe/London';
  END IF;
  IF TG_OP='INSERT' AND NEW.requested_charge_date < (clock_timestamp() AT TIME ZONE 'Europe/London')::date THEN
    RAISE EXCEPTION 'BNMS pilot cannot reserve a charge date in the past';
  END IF;
  IF NEW.collection_number=1 AND (
    NEW.due_date IS DISTINCT FROM '2026-10-01'::date
    OR NEW.requested_charge_date IS NULL
    OR NEW.requested_charge_date < '2026-10-01'::date
    OR NEW.requested_charge_date > '2026-10-08'::date
    OR NEW.amount_minor IS DISTINCT FROM 1300 OR NEW.currency IS DISTINCT FROM 'GBP'
    OR NEW.requested_charge_date IS DISTINCT FROM (NEW.provider_evidence->>'next_possible_charge_date')::date
    OR NEW.provider_evidence->>'status' IS DISTINCT FROM 'active'
    OR (NEW.provider_evidence->>'checked_at')::timestamptz IS NULL
    OR (NEW.provider_evidence->>'checked_at')::timestamptz < TIMESTAMPTZ '2026-10-01 00:00:00 Europe/London'
  ) THEN
    RAISE EXCEPTION 'BNMS pilot first collection requires October cadence GBP13 and post-gate provider date evidence';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS bnms_dd_initial_reservation_guard ON public.gocardless_collection_reservations;
CREATE TRIGGER bnms_dd_initial_reservation_guard BEFORE INSERT OR UPDATE ON public.gocardless_collection_reservations
FOR EACH ROW EXECUTE FUNCTION public.bnms_dd_guard_initial_reservation();