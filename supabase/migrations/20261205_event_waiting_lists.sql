BEGIN;

ALTER TABLE public.event ADD COLUMN waiting_list_enabled boolean NOT NULL DEFAULT false;
ALTER TABLE public.complex_event ADD COLUMN waiting_list_enabled boolean NOT NULL DEFAULT false;

-- Deliberately not booking rows: no payment, capacity, award or reminder
-- consumer can mistake an expression of interest for a confirmed booking.
CREATE TABLE public.event_waiting_registration (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  event_id uuid NOT NULL,
  event_kind text NOT NULL CHECK (event_kind IN ('simple','complex')),
  booker_member_id uuid NOT NULL,
  idempotency_key uuid NOT NULL,
  request_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, booker_member_id, idempotency_key)
);
CREATE TABLE public.event_waiting_entry (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  registration_id uuid NOT NULL REFERENCES public.event_waiting_registration(id),
  tenant_id uuid NOT NULL,
  event_id uuid NOT NULL,
  event_kind text NOT NULL CHECK (event_kind IN ('simple','complex')),
  booker_member_id uuid NOT NULL,
  member_id uuid,
  first_name text NOT NULL,
  last_name text NOT NULL,
  email text NOT NULL,
  job_title text,
  ticket_class_id text,
  ticket_name text NOT NULL,
  advertised_price numeric(14,2) NOT NULL CHECK (advertised_price >= 0),
  currency text NOT NULL,
  session_ids jsonb NOT NULL DEFAULT '[]',
  attendee_details jsonb NOT NULL DEFAULT '{}',
  event_title text NOT NULL,
  event_start_date text,
  event_end_date text,
  event_location text,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','withdrawn')),
  created_at timestamptz NOT NULL DEFAULT now(),
  withdrawn_at timestamptz,
  withdrawn_by uuid
);
CREATE INDEX event_waiting_entry_member ON public.event_waiting_entry(tenant_id,member_id,created_at,id) WHERE status='active';
CREATE INDEX event_waiting_entry_booker ON public.event_waiting_entry(tenant_id,booker_member_id,created_at,id) WHERE status='active';
CREATE INDEX event_waiting_entry_event ON public.event_waiting_entry(tenant_id,event_id,event_kind,id) WHERE status='active';
CREATE UNIQUE INDEX event_waiting_entry_active_ticket ON public.event_waiting_entry
  (tenant_id,event_id,event_kind,lower(email),coalesce(ticket_class_id,'')) WHERE status='active';

ALTER TABLE public.event_waiting_registration ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.event_waiting_entry ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.event_waiting_registration, public.event_waiting_entry FROM PUBLIC,anon,authenticated;
GRANT ALL ON public.event_waiting_registration, public.event_waiting_entry TO service_role;

CREATE FUNCTION public.create_event_waiting_registration(
  p_tenant_id uuid, p_member_id uuid, p_event_id uuid, p_event_kind text,
  p_idempotency_key uuid, p_request_hash text, p_entries jsonb
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_id uuid; v_hash text; v_event jsonb; v_entry jsonb;
BEGIN
  IF p_event_kind NOT IN ('simple','complex') OR jsonb_typeof(p_entries) IS DISTINCT FROM 'array'
     OR jsonb_array_length(p_entries) NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'Invalid waiting list registration';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(p_tenant_id::text||p_member_id::text||p_idempotency_key::text,0));
  SELECT id,request_hash INTO v_id,v_hash FROM event_waiting_registration
    WHERE tenant_id=p_tenant_id AND booker_member_id=p_member_id AND idempotency_key=p_idempotency_key;
  IF FOUND THEN
    IF v_hash IS DISTINCT FROM p_request_hash THEN RAISE EXCEPTION 'Registration retry differs from original'; END IF;
    RETURN v_id;
  END IF;
  PERFORM 1 FROM member WHERE id=p_member_id AND tenant_id=p_tenant_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Member context not found'; END IF;
  IF p_event_kind='simple' THEN
    SELECT to_jsonb(e) INTO v_event FROM event e WHERE id=p_event_id AND tenant_id=p_tenant_id FOR SHARE;
  ELSE
    SELECT to_jsonb(e) INTO v_event FROM complex_event e WHERE id=p_event_id AND tenant_id=p_tenant_id FOR SHARE;
  END IF;
  IF v_event IS NULL OR (v_event->>'waiting_list_enabled')::boolean IS NOT TRUE
    OR coalesce(v_event->>'status','') NOT IN ('published','tbc','immediate')
    OR coalesce(v_event->>'event_state','') IN ('cancelled','cancelling','closed','completed')
    OR (nullif(v_event->>'registration_closes_at','') IS NOT NULL
        AND (v_event->>'registration_closes_at')::timestamptz <= now()) THEN
    RAISE EXCEPTION 'Waiting list is not accepting registrations';
  END IF;
  INSERT INTO event_waiting_registration(tenant_id,event_id,event_kind,booker_member_id,idempotency_key,request_hash)
    VALUES(p_tenant_id,p_event_id,p_event_kind,p_member_id,p_idempotency_key,p_request_hash) RETURNING id INTO v_id;
  FOR v_entry IN SELECT value FROM jsonb_array_elements(p_entries) LOOP
    IF nullif(v_entry->>'member_id','') IS NOT NULL THEN
      PERFORM 1 FROM member WHERE id=(v_entry->>'member_id')::uuid AND tenant_id=p_tenant_id
        AND lower(trim(email))=lower(trim(v_entry->>'email'));
      IF NOT FOUND THEN RAISE EXCEPTION 'Invalid attendee membership'; END IF;
    END IF;
    INSERT INTO event_waiting_entry(registration_id,tenant_id,event_id,event_kind,booker_member_id,member_id,
      first_name,last_name,email,job_title,ticket_class_id,ticket_name,advertised_price,currency,session_ids,attendee_details,
      event_title,event_start_date,event_end_date,event_location)
    VALUES(v_id,p_tenant_id,p_event_id,p_event_kind,p_member_id,nullif(v_entry->>'member_id','')::uuid,
      v_entry->>'first_name',v_entry->>'last_name',lower(trim(v_entry->>'email')),v_entry->>'job_title',
      v_entry->>'ticket_class_id',v_entry->>'ticket_name',(v_entry->>'advertised_price')::numeric,v_entry->>'currency',
      coalesce(v_entry->'session_ids','[]'),coalesce(v_entry->'attendee_details','{}'),
      v_event->>'title',v_event->>'start_date',v_event->>'end_date',v_event->>'location');
  END LOOP;
  RETURN v_id;
END $$;

CREATE FUNCTION public.withdraw_event_waiting_entry(p_tenant_id uuid,p_member_id uuid,p_entry_id uuid,p_scope text)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_entry event_waiting_entry; v_count integer;
BEGIN
  IF p_scope NOT IN ('attendee','registration') THEN RAISE EXCEPTION 'Invalid withdrawal scope'; END IF;
  SELECT * INTO v_entry FROM event_waiting_entry WHERE id=p_entry_id AND tenant_id=p_tenant_id FOR UPDATE;
  IF NOT FOUND OR (v_entry.booker_member_id<>p_member_id AND v_entry.member_id IS DISTINCT FROM p_member_id)
    OR (p_scope='registration' AND v_entry.booker_member_id<>p_member_id) THEN
    RAISE EXCEPTION 'Waiting list entry not found or not authorised';
  END IF;
  UPDATE event_waiting_entry SET status='withdrawn',withdrawn_at=now(),withdrawn_by=p_member_id
    WHERE tenant_id=p_tenant_id AND status='active'
      AND ((p_scope='attendee' AND id=p_entry_id) OR (p_scope='registration' AND registration_id=v_entry.registration_id));
  GET DIAGNOSTICS v_count=ROW_COUNT;
  RETURN v_count;
END $$;

-- Also cover generic entity writes, imports and alternate booking entry points.
CREATE FUNCTION public.reject_waiting_list_booking() RETURNS trigger
LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE v_waiting boolean;
BEGIN
  IF TG_OP='UPDATE' AND NEW.event_id IS NOT DISTINCT FROM OLD.event_id THEN RETURN NEW; END IF;
  IF TG_TABLE_NAME='booking' THEN
    SELECT waiting_list_enabled INTO v_waiting FROM event WHERE id=NEW.event_id FOR SHARE;
  ELSE
    SELECT waiting_list_enabled INTO v_waiting FROM complex_event WHERE id=NEW.event_id FOR SHARE;
  END IF;
  IF v_waiting THEN RAISE EXCEPTION 'This event accepts waiting list entries, not confirmed bookings'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER reject_waiting_list_booking BEFORE INSERT OR UPDATE OF event_id ON public.booking
FOR EACH ROW EXECUTE FUNCTION public.reject_waiting_list_booking();
CREATE TRIGGER reject_waiting_list_booking BEFORE INSERT OR UPDATE OF event_id ON public.complex_event_booking
FOR EACH ROW EXECUTE FUNCTION public.reject_waiting_list_booking();

REVOKE ALL ON FUNCTION public.create_event_waiting_registration(uuid,uuid,uuid,text,uuid,text,jsonb) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.withdraw_event_waiting_entry(uuid,uuid,uuid,text) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.reject_waiting_list_booking() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.create_event_waiting_registration(uuid,uuid,uuid,text,uuid,text,jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.withdraw_event_waiting_entry(uuid,uuid,uuid,text) TO service_role;
NOTIFY pgrst,'reload schema';
COMMIT;
