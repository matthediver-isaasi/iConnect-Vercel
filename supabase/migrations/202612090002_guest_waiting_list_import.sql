BEGIN;
-- Guest imports have no member owner. Their source booking remains unchanged.
ALTER TABLE public.event_waiting_registration
  ALTER COLUMN booker_member_id DROP NOT NULL,
  ADD COLUMN registration_source text NOT NULL DEFAULT 'member',
  ADD COLUMN import_provenance jsonb;
ALTER TABLE public.event_waiting_registration ADD CONSTRAINT waiting_registration_source_check CHECK (
  (registration_source='member' AND booker_member_id IS NOT NULL AND import_provenance IS NULL)
  OR (registration_source='guest_import' AND booker_member_id IS NULL
    AND import_provenance IS NOT NULL
    AND jsonb_typeof(import_provenance)='object'
    AND import_provenance ?& ARRAY['source_booking_id','source_sha256','actor'])
);
CREATE UNIQUE INDEX event_waiting_guest_import_key ON public.event_waiting_registration
  (tenant_id,idempotency_key) WHERE registration_source='guest_import';
ALTER TABLE public.event_waiting_entry ALTER COLUMN booker_member_id DROP NOT NULL;

CREATE FUNCTION public.guard_waiting_registration_identity() RETURNS trigger
LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
  IF ROW(NEW.tenant_id,NEW.event_id,NEW.event_kind,NEW.booker_member_id,NEW.registration_source,
    NEW.import_provenance,NEW.idempotency_key,NEW.request_hash)
    IS DISTINCT FROM ROW(OLD.tenant_id,OLD.event_id,OLD.event_kind,OLD.booker_member_id,OLD.registration_source,
    OLD.import_provenance,OLD.idempotency_key,OLD.request_hash) THEN
    RAISE EXCEPTION 'Waiting registration identity is immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER waiting_registration_identity BEFORE UPDATE ON public.event_waiting_registration
FOR EACH ROW EXECUTE FUNCTION public.guard_waiting_registration_identity();

CREATE FUNCTION public.guard_waiting_entry_owner() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE parent public.event_waiting_registration;
BEGIN
  SELECT * INTO parent FROM public.event_waiting_registration WHERE id=NEW.registration_id;
  IF NOT FOUND OR ROW(NEW.tenant_id,NEW.event_id,NEW.event_kind,NEW.booker_member_id)
    IS DISTINCT FROM ROW(parent.tenant_id,parent.event_id,parent.event_kind,parent.booker_member_id)
    OR (parent.registration_source='guest_import' AND NEW.member_id IS NOT NULL) THEN
    RAISE EXCEPTION 'Waiting entry owner does not match registration';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER waiting_entry_owner BEFORE INSERT OR UPDATE ON public.event_waiting_entry
FOR EACH ROW EXECUTE FUNCTION public.guard_waiting_entry_owner();

-- NULL owners must never be treated as a successful permission comparison.
CREATE OR REPLACE FUNCTION public.withdraw_event_waiting_entry(p_tenant_id uuid,p_member_id uuid,p_entry_id uuid,p_scope text)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_entry event_waiting_entry; v_count integer;
BEGIN
  IF p_member_id IS NULL OR p_scope IS NULL OR p_scope NOT IN ('attendee','registration') THEN
    RAISE EXCEPTION 'Invalid withdrawal scope or member';
  END IF;
  SELECT * INTO v_entry FROM event_waiting_entry WHERE id=p_entry_id AND tenant_id=p_tenant_id FOR UPDATE;
  IF NOT FOUND OR (v_entry.booker_member_id IS DISTINCT FROM p_member_id AND v_entry.member_id IS DISTINCT FROM p_member_id)
    OR (p_scope='registration' AND v_entry.booker_member_id IS DISTINCT FROM p_member_id) THEN
    RAISE EXCEPTION 'Waiting list entry not found or not authorised';
  END IF;
  UPDATE event_waiting_entry SET status='withdrawn',withdrawn_at=now(),withdrawn_by=p_member_id
    WHERE tenant_id=p_tenant_id AND status='active'
      AND ((p_scope='attendee' AND id=p_entry_id) OR (p_scope='registration' AND registration_id=v_entry.registration_id));
  GET DIAGNOSTICS v_count=ROW_COUNT;
  RETURN v_count;
END $$;

-- Administrative import only, not a public guest-signup endpoint. Identity and
-- ticket evidence come from an existing tenant-owned standard booking.
CREATE FUNCTION public.import_guest_event_waiting_registration(
  p_tenant_id uuid,p_booking_id uuid,p_source_sha256 text,p_actor text,p_idempotency_key uuid
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE b jsonb; e jsonb; ticket jsonb; existing event_waiting_registration; rid uuid; v_email text;
BEGIN
  IF p_tenant_id IS NULL OR p_booking_id IS NULL OR p_idempotency_key IS NULL
    OR p_source_sha256 IS NULL OR p_source_sha256 !~ '^[0-9a-f]{64}$'
    OR nullif(trim(p_actor),'') IS NULL THEN RAISE EXCEPTION 'Invalid guest import evidence'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(p_tenant_id::text||':waiting-import:'||p_idempotency_key::text,0));
  SELECT * INTO existing FROM event_waiting_registration WHERE tenant_id=p_tenant_id
    AND registration_source='guest_import' AND idempotency_key=p_idempotency_key;
  IF FOUND THEN
    IF existing.import_provenance->>'source_booking_id' IS DISTINCT FROM p_booking_id::text
      OR existing.import_provenance->>'source_sha256' IS DISTINCT FROM p_source_sha256 THEN
      RAISE EXCEPTION 'Guest import identity conflict';
    END IF;
    RETURN existing.id;
  END IF;
  SELECT to_jsonb(x) INTO b FROM booking x WHERE id=p_booking_id AND tenant_id=p_tenant_id FOR SHARE;
  IF b IS NULL OR b->>'status' IS DISTINCT FROM 'confirmed' THEN RAISE EXCEPTION 'Guest source booking unavailable'; END IF;
  v_email:=lower(trim(b->>'attendee_email'));
  IF coalesce(v_email,'') !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
    OR nullif(trim(b->>'attendee_first_name'),'') IS NULL
    OR nullif(trim(b->>'attendee_last_name'),'') IS NULL THEN RAISE EXCEPTION 'Guest source details incomplete'; END IF;
  IF EXISTS(SELECT 1 FROM member m WHERE m.tenant_id=p_tenant_id AND lower(trim(m.email))=v_email) THEN
    RAISE EXCEPTION 'Attendee has a member account; use member registration';
  END IF;
  SELECT to_jsonb(x) INTO e FROM event x WHERE x.id=(b->>'event_id')::uuid AND x.tenant_id=p_tenant_id FOR SHARE;
  IF e IS NULL OR (e->>'waiting_list_enabled')::boolean IS DISTINCT FROM true
    OR coalesce(e->>'status','') NOT IN ('published','tbc','immediate')
    OR coalesce(e->>'event_state','') IN ('cancelled','cancelling','closed','completed')
    OR (nullif(e->>'registration_closes_at','') IS NOT NULL AND (e->>'registration_closes_at')::timestamptz<=now()) THEN
    RAISE EXCEPTION 'Waiting list is not accepting registrations';
  END IF;
  IF jsonb_array_length(e#>'{pricing_config,ticket_classes}') IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'Guest import ticket selection requires review';
  END IF;
  ticket:=e#>'{pricing_config,ticket_classes,0}';
  IF nullif(ticket->>'id','') IS NULL OR nullif(ticket->>'name','') IS NULL
    OR (ticket->>'price')::numeric IS DISTINCT FROM 0 THEN
    RAISE EXCEPTION 'Guest import requires an unambiguous free interest ticket';
  END IF;
  IF EXISTS(SELECT 1 FROM event_waiting_entry w WHERE w.tenant_id=p_tenant_id
    AND w.event_id=(b->>'event_id')::uuid AND w.event_kind='simple' AND lower(trim(w.email))=v_email) THEN
    RAISE EXCEPTION 'Guest already has a waiting entry; do not duplicate or reinstate';
  END IF;
  INSERT INTO event_waiting_registration(tenant_id,event_id,event_kind,booker_member_id,idempotency_key,request_hash,
    registration_source,import_provenance)
  VALUES(p_tenant_id,(b->>'event_id')::uuid,'simple',NULL,p_idempotency_key,
    md5(p_booking_id::text||':'||p_source_sha256),'guest_import',
    jsonb_build_object('source_booking_id',p_booking_id,'source_sha256',p_source_sha256,'actor',p_actor))
  RETURNING id INTO rid;
  INSERT INTO event_waiting_entry(registration_id,tenant_id,event_id,event_kind,booker_member_id,member_id,
    first_name,last_name,email,job_title,ticket_class_id,ticket_name,advertised_price,currency,attendee_details,
    event_title,event_start_date,event_end_date,event_location)
  VALUES(rid,p_tenant_id,(b->>'event_id')::uuid,'simple',NULL,NULL,
    trim(b->>'attendee_first_name'),trim(b->>'attendee_last_name'),v_email,b->>'attendee_job_title',
    ticket->>'id',ticket->>'name',0,'GBP',
    jsonb_build_object('import_source_sha256',p_source_sha256,'source_booking_id',p_booking_id),
    e->>'title',e->>'start_date',e->>'end_date',e->>'location');
  RETURN rid;
END $$;
REVOKE ALL ON FUNCTION public.import_guest_event_waiting_registration(uuid,uuid,text,text,uuid),
  public.guard_waiting_registration_identity(),public.guard_waiting_entry_owner() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.import_guest_event_waiting_registration(uuid,uuid,text,text,uuid) TO service_role;
NOTIFY pgrst,'reload schema';
COMMIT;
