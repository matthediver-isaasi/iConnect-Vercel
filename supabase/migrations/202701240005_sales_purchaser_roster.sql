BEGIN;
CREATE TABLE public.sales_purchaser_slot (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL, fulfilment_id uuid NOT NULL,
  allocation_id uuid NOT NULL, version integer NOT NULL DEFAULT 0 CHECK(version>=0),
  details jsonb NOT NULL DEFAULT '{}' CHECK(jsonb_typeof(details)='object'),
  booking_id uuid, last_command uuid, last_payload jsonb,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (fulfilment_id) REFERENCES public.sales_customer_fulfilment(id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,allocation_id) REFERENCES public.sales_commercial_allocation(tenant_id,id) ON DELETE RESTRICT
);
CREATE INDEX sales_purchaser_slot_roster ON public.sales_purchaser_slot(tenant_id,fulfilment_id,id);
CREATE TABLE public.sales_purchaser_slot_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL,
  slot_id uuid NOT NULL REFERENCES public.sales_purchaser_slot(id),
  version integer NOT NULL, before_details jsonb, after_details jsonb NOT NULL,
  terms jsonb, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(slot_id,version)
);
ALTER TABLE public.sales_purchaser_slot ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sales_purchaser_slot_audit ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.sales_purchaser_slot,public.sales_purchaser_slot_audit FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.sales_purchaser_slot TO service_role;
CREATE POLICY sales_purchaser_slot_read ON public.sales_purchaser_slot FOR SELECT TO service_role USING(true);

CREATE FUNCTION public.save_sales_purchaser_slot(
  p_tenant uuid,p_hash text,p_allocation uuid,p_slot uuid,p_expected integer,p_command uuid,
  p_details jsonb,p_complete boolean,p_invite_hash text,p_terms jsonb DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $fn$
DECLARE r public.sales_customer_fulfilment; a public.sales_commercial_allocation;
  s public.sales_purchaser_slot; previous_details jsonb; payload jsonb; e jsonb; booking jsonb;
  invitation jsonb; org uuid; v_booking_table text; cols text; vals text; capacity jsonb; booked uuid;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'service role required' USING ERRCODE='42501'; END IF;
  IF p_slot IS NULL OR p_command IS NULL OR p_expected IS NULL OR p_expected<0
    OR p_complete IS NULL OR jsonb_typeof(p_details) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'Invalid roster command' USING ERRCODE='22023';
  END IF;
  r:=jsonb_populate_record(NULL::public.sales_customer_fulfilment,public.resolve_sales_customer_fulfilment(p_tenant,p_hash));
  SELECT * INTO a FROM public.sales_commercial_allocation WHERE tenant_id=p_tenant AND sale_id=r.sale_id AND id=p_allocation;
  IF NOT FOUND THEN RAISE EXCEPTION 'Allocation not found' USING ERRCODE='P0002'; END IF;
  -- Match the current shared event -> invitation/booking -> ticket lock order.
  IF a.event_reference_kind='simple' THEN
    SELECT to_jsonb(x) INTO e FROM public.event x WHERE tenant_id=p_tenant AND id=a.event_id FOR UPDATE;
  ELSE
    SELECT to_jsonb(x) INTO e FROM public.complex_event x WHERE tenant_id=p_tenant AND id=a.event_id FOR UPDATE;
  END IF;
  IF e IS NULL THEN RAISE EXCEPTION 'Event unavailable' USING ERRCODE='22023'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('sales-roster:'||p_slot::text,0));
  SELECT * INTO s FROM public.sales_purchaser_slot WHERE id=p_slot FOR UPDATE;
  IF FOUND AND (s.tenant_id<>p_tenant OR s.fulfilment_id<>r.id OR s.allocation_id<>p_allocation) THEN
    RAISE EXCEPTION 'Slot not found' USING ERRCODE='P0002';
  END IF;
  payload:=jsonb_build_object('details',p_details,'complete',p_complete,'terms',p_terms);
  IF s.last_command=p_command THEN
    IF s.last_payload IS DISTINCT FROM payload THEN RAISE EXCEPTION 'Retry details changed' USING ERRCODE='PT409'; END IF;
    RETURN jsonb_build_object('id',s.id,'version',s.version,'details',s.details,'status',CASE WHEN s.booking_id IS NULL THEN 'draft' ELSE 'registered' END);
  END IF;
  IF COALESCE(s.version,0)<>p_expected THEN RAISE EXCEPTION 'This registration changed elsewhere. Reload before editing.' USING ERRCODE='PT409'; END IF;
  PERFORM public.sales_assert_ticket_open(p_tenant,a.event_reference_kind,a.event_id,a.ticket_type_id,false);
  IF s.id IS NULL THEN
    IF (SELECT count(*) FROM public.sales_purchaser_slot WHERE tenant_id=p_tenant AND allocation_id=p_allocation)>=a.allocated_places THEN
      RAISE EXCEPTION 'All purchased slots already have a saved record' USING ERRCODE='22023';
    END IF;
    INSERT INTO public.sales_purchaser_slot(id,tenant_id,fulfilment_id,allocation_id)
      VALUES(p_slot,p_tenant,r.id,p_allocation) RETURNING * INTO s;
  END IF;
  previous_details:=s.details;
  IF s.booking_id IS NOT NULL AND NOT p_complete THEN
    RAISE EXCEPTION 'A registered attendee must be saved as a completed registration' USING ERRCODE='22023';
  END IF;
  IF p_complete THEN
    IF length(btrim(COALESCE(p_details->>'first_name','')))=0
      OR length(btrim(COALESCE(p_details->>'last_name','')))=0
      OR COALESCE(p_details->>'email','') !~ '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$' THEN
      RAISE EXCEPTION 'Complete the attendee name and email' USING ERRCODE='22023';
    END IF;
    v_booking_table:=CASE WHEN a.event_reference_kind='complex' THEN 'complex_event_booking' ELSE 'booking' END;
    EXECUTE format('SELECT id FROM public.%I WHERE tenant_id=$1 AND event_id=$2 AND status=''confirmed''
      AND lower(attendee_email)=lower($3) AND ($4 IS NULL OR id<>$4) LIMIT 1',v_booking_table)
      INTO booked USING p_tenant,a.event_id,p_details->>'email',s.booking_id;
    IF booked IS NOT NULL THEN RAISE EXCEPTION 'This attendee already has a registration for the event' USING ERRCODE='PT409'; END IF;
    booking:=jsonb_build_object('attendee_first_name',p_details->>'first_name','attendee_last_name',p_details->>'last_name',
      'attendee_email',lower(p_details->>'email'),'attendee_phone',p_details->>'phone','attendee_job_title',p_details->>'job_title',
      'guest_organisation_name',p_details->>'organization','attendee_organization',p_details->>'organization',
      'dietary_selections',COALESCE(p_details->'dietary_selections','[]'),
      'allergy_selections',COALESCE(p_details->'allergy_selections','[]'),
      'accessibility_selections',COALESCE(p_details->'accessibility_selections','[]'));
    IF s.booking_id IS NULL THEN
      invitation:=public.reserve_sales_customer_delegate(p_tenant,p_hash,p_allocation,p_invite_hash,
        lower(p_details->>'email'),p_details->>'first_name',p_details->>'last_name','roster:'||p_slot::text);
      SELECT organization_id INTO org FROM public.sales_commercial_allocation_invitation
        WHERE tenant_id=p_tenant AND allocation_id=p_allocation AND token_hash=decode(p_invite_hash,'hex');
      booking:=booking||jsonb_build_object('id',gen_random_uuid(),'tenant_id',p_tenant,'event_id',a.event_id,
        'organization_id',org,'member_id',NULL,'status','confirmed','payment_method','free','payment_status','paid',
        'ticket_class_id',a.ticket_type_id,'ticket_class_name',COALESCE(a.ticket_snapshot->>'ticket_name',a.ticket_snapshot->>'name','Ticket'),
        'ticket_price',0,'total_cost',0,'voucher_amount',0,'training_fund_amount',0,'account_amount',0,
        'is_guest_booking',true,'is_one_off_event',true,'booking_reference','PR-'||gen_random_uuid()::text,
        'check_in_token',encode(gen_random_bytes(24),'hex'),'created_at',clock_timestamp());
      SELECT string_agg(format('%I',key),','),string_agg(format('(x.r).%I',key),',') INTO cols,vals
        FROM jsonb_object_keys(booking) key WHERE EXISTS(SELECT 1 FROM information_schema.columns c
          WHERE c.table_schema='public' AND c.table_name=v_booking_table AND c.column_name=key);
      EXECUTE format('INSERT INTO public.%I (%s) SELECT %s FROM
        (SELECT jsonb_populate_record(NULL::public.%I,$1) r) x RETURNING id',v_booking_table,cols,vals,v_booking_table)
        INTO s.booking_id USING booking;
      PERFORM public.claim_sales_allocation_invitation_with_event_seat(p_invite_hash,a.event_reference_kind,s.booking_id);
      capacity:=public.sales_capacity_state(a.event_reference_kind,a.event_id,a.ticket_type_id);
      IF (capacity->>'ok')::boolean IS DISTINCT FROM true THEN RAISE EXCEPTION 'Ticket capacity unavailable' USING ERRCODE='23514'; END IF;
      -- Whole-event total checks remain enforced by the existing deferred guards.
    ELSE
      EXECUTE format('SELECT to_jsonb(b) FROM public.%I b WHERE tenant_id=$1 AND id=$2 FOR UPDATE',v_booking_table)
        INTO e USING p_tenant,s.booking_id;
      IF e IS NULL OR e->>'status'<>'confirmed' OR e->>'checked_in_at' IS NOT NULL THEN
        RAISE EXCEPTION 'This registration cannot be amended. Contact the organiser.' USING ERRCODE='PT409';
      END IF;
      IF a.event_reference_kind='complex' THEN
        PERFORM 1 FROM public.complex_event_session_checkin
          WHERE tenant_id=p_tenant AND complex_event_id=a.event_id AND booking_id=s.booking_id
          ORDER BY id FOR UPDATE;
        IF EXISTS(SELECT 1 FROM public.complex_event_session_checkin
          WHERE tenant_id=p_tenant AND complex_event_id=a.event_id AND booking_id=s.booking_id
            AND checked_in_at IS NOT NULL) THEN
          RAISE EXCEPTION 'A checked-in attendee cannot be replaced. Contact the organiser.' USING ERRCODE='PT409';
        END IF;
        UPDATE public.complex_event_session_checkin SET token=encode(gen_random_bytes(24),'hex')
          WHERE tenant_id=p_tenant AND complex_event_id=a.event_id AND booking_id=s.booking_id;
      END IF;
      -- Retain immutable allocation/payment evidence. Rotate both entry credentials;
      -- no profile updates, additional booking, allocation movement or charge.
      booking:=booking||jsonb_build_object('check_in_token',encode(gen_random_bytes(24),'hex'),
        'booking_reference','PR-'||gen_random_uuid()::text);
      SELECT string_agg(format('%I=(x.r).%I',key,key),',') INTO cols
        FROM jsonb_object_keys(booking) key WHERE EXISTS(SELECT 1 FROM information_schema.columns c
          WHERE c.table_schema='public' AND c.table_name=v_booking_table AND c.column_name=key);
      EXECUTE format('UPDATE public.%I b SET %s FROM (SELECT jsonb_populate_record(NULL::public.%I,$1) r) x
        WHERE b.tenant_id=$2 AND b.id=$3',v_booking_table,cols,v_booking_table) USING booking,p_tenant,s.booking_id;
    END IF;
  END IF;
  UPDATE public.sales_purchaser_slot SET version=version+1,details=p_details,booking_id=s.booking_id,
    last_command=p_command,last_payload=payload,updated_at=clock_timestamp() WHERE id=s.id RETURNING * INTO s;
  INSERT INTO public.sales_purchaser_slot_audit(tenant_id,slot_id,version,before_details,after_details,terms)
    VALUES(p_tenant,s.id,s.version,previous_details,s.details,p_terms);
  RETURN jsonb_build_object('id',s.id,'version',s.version,'details',s.details,'status',CASE WHEN s.booking_id IS NULL THEN 'draft' ELSE 'registered' END);
END $fn$;
REVOKE ALL ON FUNCTION public.save_sales_purchaser_slot(uuid,text,uuid,uuid,integer,uuid,jsonb,boolean,text,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.save_sales_purchaser_slot(uuid,text,uuid,uuid,integer,uuid,jsonb,boolean,text,jsonb) TO service_role;
NOTIFY pgrst,'reload schema';
COMMIT;
