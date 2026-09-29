BEGIN;
-- Task 4850. Forward-only hold for NEW import-owned standard registrations.
-- Install the hold before inserting its booking, in the SAME transaction.
-- No generic survey credential/grant tables or functions are changed.
CREATE TABLE public.outstanding_registration_award_hold (
  booking_id uuid PRIMARY KEY REFERENCES public.booking(id) DEFERRABLE INITIALLY DEFERRED,
  tenant_id uuid NOT NULL CHECK (tenant_id='ff2df806-b321-4254-b651-3af11fccf1db'),
  event_id uuid NOT NULL CHECK (event_id='66050b3c-aa70-4174-8552-0a2af85e5410'),
  source_sha256 text NOT NULL CHECK (source_sha256='5fc106677f343951c341536141b7feaf13afe7a7f8cb4265e114e24c4ea68e19'),
  booking_reference text NOT NULL CHECK (length(booking_reference)>0),
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.outstanding_registration_award_hold ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.outstanding_registration_award_hold FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT,INSERT ON public.outstanding_registration_award_hold TO service_role;

CREATE FUNCTION public.validate_outstanding_registration_hold() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Registration award hold is immutable'; END IF;
  -- Serialize with all booking writers, including a concurrent attach attempt.
  LOCK TABLE public.booking IN SHARE ROW EXCLUSIVE MODE;
  IF EXISTS(SELECT 1 FROM booking WHERE id=NEW.booking_id) THEN
    RAISE EXCEPTION 'Award hold cannot attach to an existing registration';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM event WHERE id=NEW.event_id AND tenant_id=NEW.tenant_id) THEN
    RAISE EXCEPTION 'Award hold event ownership mismatch';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER validate_outstanding_registration_hold
BEFORE INSERT OR UPDATE OR DELETE ON public.outstanding_registration_award_hold
FOR EACH ROW EXECUTE FUNCTION public.validate_outstanding_registration_hold();

CREATE FUNCTION public.check_outstanding_registration_hold_booking() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE h public.outstanding_registration_award_hold;
BEGIN
  IF TG_TABLE_NAME='booking' THEN
    SELECT * INTO h FROM outstanding_registration_award_hold WHERE booking_id=NEW.id;
    IF NOT FOUND THEN RETURN NEW; END IF;
  ELSE h:=NEW;
  END IF;
  IF NOT EXISTS(SELECT 1 FROM booking b WHERE b.id=h.booking_id AND b.tenant_id=h.tenant_id
    AND b.event_id=h.event_id AND b.booking_reference=h.booking_reference
    AND b.payment_method='admin_import') THEN
    RAISE EXCEPTION 'Award hold requires exact import-owned booking';
  END IF;
  RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER outstanding_hold_booking_required
AFTER INSERT ON public.outstanding_registration_award_hold DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION public.check_outstanding_registration_hold_booking();
CREATE CONSTRAINT TRIGGER outstanding_hold_booking_preserved
AFTER INSERT OR UPDATE ON public.booking DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION public.check_outstanding_registration_hold_booking();

-- Key solely by globally unique standard booking ID. Malformed tenant/event
-- payloads must not bypass the hold before the normal writer validates them.
CREATE FUNCTION public.outstanding_registration_is_held(p_booking_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public AS $$
  SELECT EXISTS(SELECT 1 FROM outstanding_registration_award_hold WHERE booking_id=p_booking_id)
$$;

CREATE FUNCTION public.guard_outstanding_registration_awards() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
BEGIN
  IF public.outstanding_registration_is_held(NEW.booking_id) THEN
    IF TG_TABLE_NAME IN ('event_cpd_points_outbox','event_cpd_badge_outbox') THEN
      -- Both ordinary enqueue and replay hit this guard. No job becomes visible
      -- to a worker, even on an update, before or after import commit.
      RETURN NULL;
    END IF;
    RAISE EXCEPTION 'Registration-only import award hold';
  END IF;
  RETURN NEW;
END $$;
DO $$
DECLARE tab text;
BEGIN
  FOREACH tab IN ARRAY ARRAY['event_cpd_points_outbox','event_cpd_badge_outbox',
    'member_cpd_points_ledger','member_badge','event_cpd_points_award_attempt',
    'event_cpd_badge_award_attempt','attendee_cpd_certificate_delivery']
  LOOP
    EXECUTE format('CREATE TRIGGER outstanding_registration_award_guard BEFORE INSERT OR UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.guard_outstanding_registration_awards()',tab);
  END LOOP;
END $$;

-- Patch the existing public entry points in place: no renamed callable bypass,
-- unchanged signatures/grants, unchanged behavior for all non-held bookings.
-- Exact sentinel checks fail closed when an upstream definition has drifted.
DO $patch$
DECLARE signature text; definition text; sentinel text; replacement text;
BEGIN
  FOREACH signature IN ARRAY ARRAY[
    'public.record_event_cpd_points_award(jsonb)',
    'public.record_event_cpd_badge_award(jsonb)',
    'public.claim_attendee_cpd_certificate_delivery(uuid,text,uuid,uuid,text,text,text,jsonb,boolean,text)'
  ] LOOP
    definition:=pg_get_functiondef(signature::regprocedure);
    sentinel:='IF auth.role() IS DISTINCT FROM ''service_role'' THEN RAISE EXCEPTION ''service_role is required''; END IF;';
    IF signature LIKE '%record_event_cpd_badge_award%' THEN
      sentinel:=E'IF auth.role() IS DISTINCT FROM ''service_role'' THEN\n    RAISE EXCEPTION ''service_role is required'';\n  END IF;';
    END IF;
    IF position(sentinel in definition)=0 OR
      length(definition)-length(replace(definition,sentinel,''))<>length(sentinel) THEN
      RAISE EXCEPTION 'Award hold migration definition drift: %',signature;
    END IF;
    replacement:=sentinel||E'\n IF public.outstanding_registration_is_held('||
      CASE WHEN signature LIKE '%claim_attendee%' THEN 'p_booking_id'
        ELSE '(p_attempt->>''booking_id'')::uuid' END||
      ') THEN RAISE EXCEPTION ''Registration-only import award hold''; END IF;';
    EXECUTE replace(definition,sentinel,replacement);
  END LOOP;
  signature:='public.evaluate_event_cpd_points_reprocessing_row(uuid,text,uuid,uuid)';
  definition:=pg_get_functiondef(signature::regprocedure);
  sentinel:='ELSIF b->>''status'' IS DISTINCT FROM ''confirmed'' THEN outcome:=''ineligible'';';
  IF position(sentinel in definition)=0 OR
    length(definition)-length(replace(definition,sentinel,''))<>length(sentinel) THEN
    RAISE EXCEPTION 'Award hold migration evaluator drift';
  END IF;
  replacement:='ELSIF public.outstanding_registration_is_held(p_booking_id) THEN outcome:=''registration_only_hold'';'||E'\n '||sentinel;
  EXECUTE replace(definition,sentinel,replacement);
END $patch$;

REVOKE ALL ON FUNCTION public.validate_outstanding_registration_hold(),
  public.check_outstanding_registration_hold_booking(),
  public.outstanding_registration_is_held(uuid),
  public.guard_outstanding_registration_awards() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.outstanding_registration_is_held(uuid) TO service_role;
COMMIT;