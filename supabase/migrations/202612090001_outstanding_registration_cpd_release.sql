BEGIN;
-- Preserve original import provenance and badge restrictions. Release only
-- explicitly reviewed bookings for member points and attendee certificates.
CREATE TABLE public.outstanding_registration_cpd_release (
  booking_id uuid PRIMARY KEY REFERENCES public.outstanding_registration_award_hold(booking_id),
  tenant_id uuid NOT NULL CHECK (tenant_id='ff2df806-b321-4254-b651-3af11fccf1db'),
  event_id uuid NOT NULL CHECK (event_id='66050b3c-aa70-4174-8552-0a2af85e5410'),
  reason text NOT NULL CHECK (length(trim(reason))>0),
  approved_by text NOT NULL CHECK (length(trim(approved_by))>0),
  released_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.outstanding_registration_cpd_release ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.outstanding_registration_cpd_release FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.outstanding_registration_cpd_release TO service_role;

CREATE FUNCTION public.validate_outstanding_registration_cpd_release() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'CPD release evidence is immutable'; END IF;
  IF NOT EXISTS(SELECT 1 FROM outstanding_registration_award_hold h
    WHERE h.booking_id=NEW.booking_id AND h.tenant_id=NEW.tenant_id AND h.event_id=NEW.event_id) THEN
    RAISE EXCEPTION 'CPD release does not match the original import hold';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER validate_outstanding_registration_cpd_release
BEFORE INSERT OR UPDATE OR DELETE ON public.outstanding_registration_cpd_release
FOR EACH ROW EXECUTE FUNCTION public.validate_outstanding_registration_cpd_release();

CREATE FUNCTION public.outstanding_registration_is_held_for(p_booking_id uuid,p_purpose text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public AS $$
  SELECT public.outstanding_registration_is_held(p_booking_id)
    AND NOT (coalesce(p_purpose IN ('points','attendee'),false)
      AND EXISTS(SELECT 1 FROM outstanding_registration_cpd_release r WHERE r.booking_id=p_booking_id))
$$;

CREATE OR REPLACE FUNCTION public.guard_outstanding_registration_awards() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE purpose text;
BEGIN
  purpose:=CASE
    WHEN TG_TABLE_NAME IN ('event_cpd_points_outbox','member_cpd_points_ledger','event_cpd_points_award_attempt') THEN 'points'
    WHEN TG_TABLE_NAME='attendee_cpd_certificate_delivery' THEN to_jsonb(NEW)->>'purpose'
    ELSE 'badge' END;
  IF public.outstanding_registration_is_held_for(NEW.booking_id,purpose) THEN
    IF TG_TABLE_NAME IN ('event_cpd_points_outbox','event_cpd_badge_outbox') THEN RETURN NULL; END IF;
    RAISE EXCEPTION 'Registration-only import award hold';
  END IF;
  RETURN NEW;
END $$;

DO $patch$
DECLARE signature text; definition text; old_call text; new_call text;
BEGIN
  FOREACH signature IN ARRAY ARRAY[
    'public.record_event_cpd_points_award(jsonb)',
    'public.evaluate_event_cpd_points_reprocessing_row(uuid,text,uuid,uuid)',
    'public.claim_attendee_cpd_certificate_delivery(uuid,text,uuid,uuid,text,text,text,jsonb,boolean,text)'
  ] LOOP
    definition:=pg_get_functiondef(signature::regprocedure);
    IF signature LIKE '%record_event%' THEN
      old_call:='public.outstanding_registration_is_held((p_attempt->>''booking_id'')::uuid)';
      new_call:='public.outstanding_registration_is_held_for((p_attempt->>''booking_id'')::uuid,''points'')';
    ELSE
      old_call:='public.outstanding_registration_is_held(p_booking_id)';
      new_call:=CASE WHEN signature LIKE '%claim_attendee%'
        THEN 'public.outstanding_registration_is_held_for(p_booking_id,p_purpose)'
        ELSE 'public.outstanding_registration_is_held_for(p_booking_id,''points'')' END;
    END IF;
    IF position(old_call in definition)=0 OR
      length(definition)-length(replace(definition,old_call,''))<>length(old_call) THEN
      RAISE EXCEPTION 'CPD release definition drift: %',signature;
    END IF;
    EXECUTE replace(definition,old_call,new_call);
  END LOOP;
END $patch$;
REVOKE ALL ON FUNCTION public.validate_outstanding_registration_cpd_release(),
  public.outstanding_registration_is_held_for(uuid,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.outstanding_registration_is_held_for(uuid,text) TO service_role;
COMMIT;
