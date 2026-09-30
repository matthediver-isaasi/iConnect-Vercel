-- Additive correction to the already-applied processing guard. Never rewrite
-- the applied migration. Provider attachment replaces provider_evidence.status
-- with PAYMENT status; mandate-active evidence is validated only on INSERT.
-- Review/apply transactionally before any pilot reservation exists.
LOCK TABLE public.gocardless_collection_reservations IN SHARE ROW EXCLUSIVE MODE;
DO $$ BEGIN
  IF EXISTS(SELECT FROM gocardless_collection_reservations r JOIN bnms_dd_pilot_adoption a ON a.plan_id=r.plan_id) THEN
    RAISE EXCEPTION 'Pilot reservations exist; reconcile before lifecycle correction';
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
    OR (TG_OP='INSERT' AND NEW.provider_evidence->>'status' IS DISTINCT FROM 'active')
    OR (TG_OP='UPDATE' AND (
      NEW.provider_evidence->>'next_possible_charge_date' IS DISTINCT FROM OLD.provider_evidence->>'next_possible_charge_date'
      OR NEW.provider_evidence->>'checked_at' IS DISTINCT FROM OLD.provider_evidence->>'checked_at'))
    OR (NEW.provider_evidence->>'checked_at')::timestamptz IS NULL
    OR (NEW.provider_evidence->>'checked_at')::timestamptz < TIMESTAMPTZ '2026-10-01 00:00:00 Europe/London'
  ) THEN
    RAISE EXCEPTION 'BNMS pilot first collection requires October cadence GBP13 and immutable post-gate mandate evidence';
  END IF;
  RETURN NEW;
END $$;