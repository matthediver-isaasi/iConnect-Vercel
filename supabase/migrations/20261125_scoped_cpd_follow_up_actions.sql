-- Service-only, explicitly confirmed follow-up actions. No work is enqueued here.
BEGIN;
DO $$
DECLARE definition text; original text;
BEGIN
  original := pg_get_functiondef('public.enqueue_event_cpd_badge_replay(uuid,text,uuid,uuid,text)'::regprocedure);
  IF (SELECT count(*) FROM regexp_matches(original,'b\.status=''confirmed''','g'))<>4
    OR (SELECT count(*) FROM regexp_matches(original,'replay_booking\.status=''confirmed''','g'))<>2 THEN
    RAISE EXCEPTION 'Badge replay sources changed; audit all registration filters before applying';
  END IF;
  definition := replace(original, 'enqueue_event_cpd_badge_replay(', 'enqueue_event_cpd_badge_registration_replay(');
  definition := replace(definition, 'p_actor text)', 'p_actor text, p_booking_id uuid)');
  definition := replace(definition, 'b.status=''confirmed''', 'b.status=''confirmed'' AND b.id=p_booking_id');
  definition := replace(definition, 'replay_booking.status=''confirmed''',
    'replay_booking.status=''confirmed'' AND replay_booking.id=p_booking_id');
  IF definition=original OR position('p_booking_id uuid' IN definition)=0
    OR position('b.id=p_booking_id' IN definition)=0
    OR position('replay_booking.id=p_booking_id' IN definition)=0 THEN
    RAISE EXCEPTION 'Unexpected badge replay definition; review scoped migration';
  END IF;
  EXECUTE definition;
END $$;
REVOKE ALL ON FUNCTION public.enqueue_event_cpd_badge_registration_replay(uuid,text,uuid,uuid,text,uuid)
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.enqueue_event_cpd_badge_registration_replay(uuid,text,uuid,uuid,text,uuid) TO service_role;

ALTER TABLE public.attendee_cpd_certificate_delivery DROP CONSTRAINT IF EXISTS attendee_cpd_certificate_delivery_purpose_check;
ALTER TABLE public.attendee_cpd_certificate_delivery ADD CONSTRAINT attendee_cpd_certificate_delivery_purpose_check
  CHECK (purpose IN ('attendee','test','badge'));
DO $$
DECLARE definition text; original text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO STRICT original FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND p.proname='claim_attendee_cpd_certificate_delivery' AND p.pronargs=10;
  definition:=replace(original, 'p_purpose NOT IN (''attendee'',''test'')',
    'p_purpose NOT IN (''attendee'',''test'',''badge'')');
  definition:=replace(definition, 'p_purpose=''attendee'' AND FOUND',
    'p_purpose IN (''attendee'',''badge'') AND FOUND');
  IF position('p_purpose NOT IN (''attendee'',''test'',''badge'')' IN definition)=0
    OR position('p_purpose IN (''attendee'',''badge'') AND FOUND' IN definition)=0 THEN
    RAISE EXCEPTION 'Unexpected certificate claim definition; review migration';
  END IF;
  EXECUTE definition;
END $$;
COMMIT;
