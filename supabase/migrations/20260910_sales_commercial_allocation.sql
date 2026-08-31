-- Task #3880: commercial ticket allocations created at the quote-sale boundary.
-- Allocation facts and their movements deliberately retain event/ticket snapshots
-- and do not foreign-key mutable ticket sources.

CREATE TABLE public.sales_commercial_sale (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenant(id) ON DELETE CASCADE,
  quote_id uuid NOT NULL,
  quote_version_id uuid NOT NULL,
  opportunity_id uuid,
  idempotency_key text NOT NULL,
  confirmed_by_kind varchar(20) NOT NULL,
  confirmed_by_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, quote_id),
  UNIQUE (tenant_id, idempotency_key),
  FOREIGN KEY (tenant_id, quote_id) REFERENCES public.sales_quote(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, quote_version_id) REFERENCES public.sales_quote_version(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, opportunity_id) REFERENCES public.opportunity(tenant_id,id) ON DELETE RESTRICT,
  CHECK (length(btrim(idempotency_key)) BETWEEN 1 AND 200),
  CHECK (confirmed_by_kind IN ('tenant_user','member'))
);

CREATE TABLE public.sales_commercial_allocation (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  sale_id uuid NOT NULL,
  quote_line_id uuid NOT NULL,
  bundle_component_id uuid,
  event_reference_kind varchar(20) NOT NULL,
  event_id uuid NOT NULL,
  ticket_type_id text NOT NULL,
  allocated_places integer NOT NULL,
  group_size integer NOT NULL DEFAULT 1,
  event_snapshot jsonb NOT NULL,
  ticket_snapshot jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id,id),
  FOREIGN KEY (tenant_id,sale_id) REFERENCES public.sales_commercial_sale(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,quote_line_id) REFERENCES public.sales_quote_line(tenant_id,id) ON DELETE RESTRICT,
  CHECK (event_reference_kind IN ('simple','complex')),
  CHECK (length(ticket_type_id)>0 AND allocated_places>0 AND group_size>0),
  CHECK (jsonb_typeof(event_snapshot)='object' AND jsonb_typeof(ticket_snapshot)='object')
);
CREATE UNIQUE INDEX sales_allocation_line_once
  ON public.sales_commercial_allocation(tenant_id,quote_line_id)
  WHERE bundle_component_id IS NULL;
CREATE UNIQUE INDEX sales_allocation_component_once
  ON public.sales_commercial_allocation(tenant_id,bundle_component_id)
  WHERE bundle_component_id IS NOT NULL;
CREATE INDEX sales_allocation_capacity_key
  ON public.sales_commercial_allocation(tenant_id,event_reference_kind,event_id,ticket_type_id);

CREATE TABLE public.sales_commercial_allocation_movement (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  allocation_id uuid NOT NULL,
  movement_kind varchar(20) NOT NULL,
  places integer NOT NULL,
  idempotency_key text NOT NULL,
  actor_kind varchar(20) NOT NULL,
  actor_id uuid NOT NULL,
  reason text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id,allocation_id,idempotency_key),
  FOREIGN KEY (tenant_id,allocation_id) REFERENCES public.sales_commercial_allocation(tenant_id,id) ON DELETE RESTRICT,
  CHECK (movement_kind IN ('allocated','named','reserved','unnamed','unreserved','released','cancelled')),
  CHECK (places>0 AND length(btrim(idempotency_key)) BETWEEN 1 AND 200),
  CHECK (actor_kind IN ('tenant_user','member','system')),
  CHECK (jsonb_typeof(metadata)='object')
);

-- A polymorphic immutable link is intentional: deleting a source booking must
-- not delete the historic commercial snapshot or movement.
CREATE TABLE public.sales_commercial_allocation_booking (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  allocation_id uuid NOT NULL,
  booking_kind varchar(20) NOT NULL,
  booking_id uuid NOT NULL,
  places integer NOT NULL,
  designation varchar(20) NOT NULL,
  booking_snapshot jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id,booking_kind,booking_id),
  FOREIGN KEY (tenant_id,allocation_id) REFERENCES public.sales_commercial_allocation(tenant_id,id) ON DELETE RESTRICT,
  CHECK (booking_kind IN ('simple','complex')),
  CHECK (designation IN ('named','reserved')),
  CHECK (places>0 AND jsonb_typeof(booking_snapshot)='object')
);
CREATE UNIQUE INDEX sales_allocation_booking_unreconciled_once
  ON public.sales_commercial_allocation_movement(
    tenant_id,allocation_id,(metadata->>'bookingKind'),(metadata->>'bookingId')
  )
  WHERE movement_kind IN ('unnamed','unreserved');

CREATE OR REPLACE FUNCTION public.guard_sales_commercial_append_only()
RETURNS trigger LANGUAGE plpgsql SET search_path=public AS $$
BEGIN
  RAISE EXCEPTION 'Commercial allocation records are append-only'
    USING ERRCODE='23514';
END $$;
CREATE TRIGGER sales_commercial_sale_immutable BEFORE UPDATE OR DELETE ON public.sales_commercial_sale
  FOR EACH ROW EXECUTE FUNCTION public.guard_sales_commercial_append_only();
CREATE TRIGGER sales_commercial_allocation_immutable BEFORE UPDATE OR DELETE ON public.sales_commercial_allocation
  FOR EACH ROW EXECUTE FUNCTION public.guard_sales_commercial_append_only();
CREATE TRIGGER sales_commercial_movement_immutable BEFORE UPDATE OR DELETE ON public.sales_commercial_allocation_movement
  FOR EACH ROW EXECUTE FUNCTION public.guard_sales_commercial_append_only();
CREATE TRIGGER sales_commercial_booking_link_immutable BEFORE UPDATE OR DELETE ON public.sales_commercial_allocation_booking
  FOR EACH ROW EXECUTE FUNCTION public.guard_sales_commercial_append_only();

CREATE VIEW public.sales_commercial_allocation_totals AS
SELECT a.id AS allocation_id,a.tenant_id,a.sale_id,a.event_reference_kind,a.event_id,a.ticket_type_id,
  COALESCE(sum(m.places) FILTER (WHERE m.movement_kind='allocated'),0)::bigint AS allocated,
  (COALESCE(sum(m.places) FILTER (WHERE m.movement_kind='named'),0)
   -COALESCE(sum(m.places) FILTER (WHERE m.movement_kind='unnamed'),0))::bigint AS named,
  (COALESCE(sum(m.places) FILTER (WHERE m.movement_kind='reserved'),0)
   -COALESCE(sum(m.places) FILTER (WHERE m.movement_kind='unreserved'),0))::bigint AS reserved,
  COALESCE(sum(m.places) FILTER (WHERE m.movement_kind='released'),0)::bigint AS released,
  COALESCE(sum(m.places) FILTER (WHERE m.movement_kind='cancelled'),0)::bigint AS cancelled,
  (COALESCE(sum(m.places) FILTER (WHERE m.movement_kind='allocated'),0)
   -COALESCE(sum(m.places) FILTER (WHERE m.movement_kind IN ('released','cancelled')),0))::bigint AS remaining
FROM public.sales_commercial_allocation a
LEFT JOIN public.sales_commercial_allocation_movement m
  ON m.tenant_id=a.tenant_id AND m.allocation_id=a.id
GROUP BY a.id,a.tenant_id,a.sale_id,a.event_reference_kind,a.event_id,a.ticket_type_id;

CREATE OR REPLACE FUNCTION public.sales_capacity_state(
  p_event_kind text,p_event_id uuid,p_ticket_type_id text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_max integer; v_confirmed integer; v_unused integer; v_used integer; v_ticket jsonb;
DECLARE v_tenant_id uuid;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(
    CASE WHEN p_event_kind='complex' THEN 'cx:' ELSE '' END
      ||p_event_id::text||':'||p_ticket_type_id,0));
  IF p_event_kind='simple' THEN
    SELECT e.tenant_id,tc INTO v_tenant_id,v_ticket FROM public.event e
    CROSS JOIN LATERAL jsonb_array_elements(
      CASE WHEN jsonb_typeof(e.pricing_config->'ticket_classes')='array'
        THEN e.pricing_config->'ticket_classes' ELSE '[]'::jsonb END) tc
    WHERE e.id=p_event_id AND tc->>'id'=p_ticket_type_id LIMIT 1;
    IF v_ticket IS NULL OR COALESCE((v_ticket->>'is_unlimited_tickets')::boolean,false)
       OR NULLIF(btrim(v_ticket->>'available_count'),'') IS NULL THEN
      RETURN jsonb_build_object('unlimited',true,'ok',true);
    END IF;
    BEGIN v_max:=(v_ticket->>'available_count')::integer;
    EXCEPTION WHEN others THEN RETURN jsonb_build_object('unlimited',true,'ok',true,'reason','non_numeric_max'); END;
    SELECT count(*) INTO v_confirmed FROM public.booking
      WHERE tenant_id=v_tenant_id AND event_id=p_event_id AND ticket_class_id=p_ticket_type_id AND status='confirmed';
  ELSIF p_event_kind='complex' THEN
    SELECT tenant_id,available_count INTO v_tenant_id,v_max FROM public.complex_event_ticket_class
      WHERE complex_event_id=p_event_id AND id::text=p_ticket_type_id
        AND NOT is_unlimited_tickets;
    IF NOT FOUND OR v_max IS NULL THEN RETURN jsonb_build_object('unlimited',true,'ok',true); END IF;
    SELECT count(*) INTO v_confirmed FROM public.complex_event_booking
      WHERE tenant_id=v_tenant_id AND event_id=p_event_id AND ticket_class_id=p_ticket_type_id AND status='confirmed';
  ELSE
    RAISE EXCEPTION 'invalid event kind' USING ERRCODE='22023';
  END IF;

  -- Named/reserved commercial places are represented by confirmed booking rows.
  -- Only the still-unused part of an allocation is added to ordinary bookings.
  SELECT COALESCE(sum(greatest(t.remaining-t.named-t.reserved,0)),0)::integer INTO v_unused
  FROM public.sales_commercial_allocation_totals t
  WHERE t.tenant_id=v_tenant_id AND t.event_reference_kind=p_event_kind AND t.event_id=p_event_id
    AND t.ticket_type_id=p_ticket_type_id;
  v_used:=v_confirmed+v_unused;
  RETURN jsonb_build_object('ok',v_used<=v_max,'unlimited',false,'max',v_max,
    'confirmed',v_confirmed,'commercialUnused',v_unused,'used',v_used,'remaining',greatest(v_max-v_used,0));
END $$;

CREATE OR REPLACE FUNCTION public.confirm_sales_quote_sale(
 p_tenant_id uuid,p_quote_id uuid,p_expected_version integer,p_idempotency_key text,
 p_actor_kind text,p_actor_id uuid
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE q public.sales_quote%ROWTYPE; v public.sales_quote_version%ROWTYPE;
DECLARE sale public.sales_commercial_sale%ROWTYPE; candidate record; allocation_id uuid;
DECLARE places numeric; multiplier integer; capacity jsonb; won_stage public.opportunity_stage%ROWTYPE;
BEGIN
 IF auth.role()<>'service_role' THEN RAISE EXCEPTION 'service role required' USING ERRCODE='42501'; END IF;
 IF p_tenant_id IS NULL OR p_quote_id IS NULL OR p_actor_id IS NULL
   OR p_actor_kind NOT IN ('tenant_user','member')
   OR length(btrim(COALESCE(p_idempotency_key,''))) NOT BETWEEN 1 AND 200
 THEN RAISE EXCEPTION 'invalid sale confirmation' USING ERRCODE='22023'; END IF;

 SELECT * INTO sale FROM public.sales_commercial_sale
   WHERE tenant_id=p_tenant_id AND idempotency_key=p_idempotency_key;
 IF FOUND THEN
   IF sale.quote_id<>p_quote_id THEN RAISE EXCEPTION 'idempotency key belongs to another quote' USING ERRCODE='23505'; END IF;
   RETURN jsonb_build_object('saleId',sale.id,'idempotent',true);
 END IF;
 SELECT * INTO q FROM public.sales_quote WHERE tenant_id=p_tenant_id AND id=p_quote_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'quote not found' USING ERRCODE='P0002'; END IF;
  SELECT * INTO sale FROM public.sales_commercial_sale
    WHERE tenant_id=p_tenant_id AND idempotency_key=p_idempotency_key;
  IF FOUND THEN
    IF sale.quote_id<>p_quote_id THEN RAISE EXCEPTION 'idempotency key belongs to another quote' USING ERRCODE='23505'; END IF;
    RETURN jsonb_build_object('saleId',sale.id,'idempotent',true);
  END IF;
 IF q.row_version<>p_expected_version THEN RAISE EXCEPTION 'quote version conflict' USING ERRCODE='40001'; END IF;
 SELECT * INTO v FROM public.sales_quote_version
   WHERE tenant_id=p_tenant_id AND quote_id=q.id AND version_number=q.current_version FOR UPDATE;
 IF v.status<>'accepted' THEN RAISE EXCEPTION 'only an accepted quote can become a sale' USING ERRCODE='23514'; END IF;

 CREATE TEMP TABLE pg_temp.sale_candidates ON COMMIT DROP AS
 SELECT l.id quote_line_id,NULL::uuid component_id,p.event_reference_kind,p.event_id,p.ticket_type_id,
   l.quantity quantity,1 component_quantity,l.catalogue_snapshot ticket_snapshot
 FROM public.sales_quote_line l JOIN public.sales_catalogue_product p
   ON p.tenant_id=l.tenant_id AND p.id=l.product_id
 WHERE l.tenant_id=p_tenant_id AND l.quote_version_id=v.id AND p.event_id IS NOT NULL
 UNION ALL
 SELECT l.id,c.id,p.event_reference_kind,p.event_id,p.ticket_type_id,
   l.quantity,c.quantity,c.product_snapshot
 FROM public.sales_quote_line l JOIN public.sales_quote_bundle_component c
   ON c.tenant_id=l.tenant_id AND c.quote_line_id=l.id
 JOIN public.sales_catalogue_product p ON p.tenant_id=c.tenant_id AND p.id=c.product_id
 WHERE l.tenant_id=p_tenant_id AND l.quote_version_id=v.id AND p.event_id IS NOT NULL;
 IF NOT EXISTS(SELECT 1 FROM pg_temp.sale_candidates) THEN
   RAISE EXCEPTION 'quote contains no event-bearing sale lines' USING ERRCODE='23514';
 END IF;

 -- Every transaction takes all ticket locks in the same lexical order.
 FOR candidate IN SELECT DISTINCT event_reference_kind,event_id,ticket_type_id
   FROM pg_temp.sale_candidates ORDER BY event_reference_kind,event_id,ticket_type_id
 LOOP
   PERFORM pg_advisory_xact_lock(hashtextextended(
     CASE WHEN candidate.event_reference_kind='complex' THEN 'cx:' ELSE '' END
       ||candidate.event_id::text||':'||candidate.ticket_type_id,0));
 END LOOP;

 INSERT INTO public.sales_commercial_sale(tenant_id,quote_id,quote_version_id,opportunity_id,
   idempotency_key,confirmed_by_kind,confirmed_by_id)
 VALUES(p_tenant_id,q.id,v.id,q.opportunity_id,p_idempotency_key,p_actor_kind,p_actor_id)
 RETURNING * INTO sale;

 FOR candidate IN SELECT * FROM pg_temp.sale_candidates
   ORDER BY event_reference_kind,event_id,ticket_type_id,quote_line_id,component_id
 LOOP
   multiplier:=1;
   IF candidate.event_reference_kind='complex' THEN
      SELECT CASE WHEN is_group_ticket THEN COALESCE(group_size,1) ELSE 1 END INTO multiplier
       FROM public.complex_event_ticket_class
        WHERE tenant_id=p_tenant_id AND complex_event_id=candidate.event_id AND id::text=candidate.ticket_type_id;
   ELSE
     SELECT CASE WHEN COALESCE((tc->>'is_group_ticket')::boolean,false)
       THEN COALESCE(NULLIF(tc->>'group_size','')::integer,1) ELSE 1 END INTO multiplier
      FROM public.event e CROSS JOIN LATERAL jsonb_array_elements(e.pricing_config->'ticket_classes') tc
      WHERE e.tenant_id=p_tenant_id AND e.id=candidate.event_id AND tc->>'id'=candidate.ticket_type_id LIMIT 1;
   END IF;
   IF multiplier IS NULL THEN RAISE EXCEPTION 'ticket source not found' USING ERRCODE='P0002'; END IF;
   places:=candidate.quantity*candidate.component_quantity*multiplier;
   IF places<>trunc(places) OR places<=0 OR places>2147483647 THEN
     RAISE EXCEPTION 'ticket quantity must resolve to whole places' USING ERRCODE='22023';
   END IF;
   INSERT INTO public.sales_commercial_allocation(tenant_id,sale_id,quote_line_id,bundle_component_id,
     event_reference_kind,event_id,ticket_type_id,allocated_places,group_size,event_snapshot,ticket_snapshot)
   VALUES(p_tenant_id,sale.id,candidate.quote_line_id,candidate.component_id,candidate.event_reference_kind,
     candidate.event_id,candidate.ticket_type_id,places::integer,multiplier,
     COALESCE(v.event_snapshot,'{}'::jsonb),COALESCE(candidate.ticket_snapshot,'{}'::jsonb))
   RETURNING id INTO allocation_id;
   INSERT INTO public.sales_commercial_allocation_movement(tenant_id,allocation_id,movement_kind,places,
     idempotency_key,actor_kind,actor_id)
   VALUES(p_tenant_id,allocation_id,'allocated',places::integer,'confirm:'||p_idempotency_key,p_actor_kind,p_actor_id);
 END LOOP;

 FOR candidate IN SELECT event_reference_kind,event_id,ticket_type_id,sum(quantity*component_quantity*
   CASE WHEN event_reference_kind='complex' THEN
     COALESCE((SELECT CASE WHEN t.is_group_ticket THEN t.group_size ELSE 1 END
       FROM public.complex_event_ticket_class t WHERE t.complex_event_id=c.event_id AND t.id::text=c.ticket_type_id),1)
   ELSE 1 END)::integer requested
   FROM pg_temp.sale_candidates c GROUP BY event_reference_kind,event_id,ticket_type_id
 LOOP
   capacity:=public.sales_capacity_state(candidate.event_reference_kind,candidate.event_id,candidate.ticket_type_id);
   IF NOT COALESCE((capacity->>'ok')::boolean,false) THEN
     RAISE EXCEPTION 'commercial allocation exceeds ticket capacity' USING ERRCODE='23514';
   END IF;
 END LOOP;

 UPDATE public.sales_quote_version SET status='converted',updated_at=now() WHERE id=v.id;
  UPDATE public.sales_quote SET row_version=row_version+1,updated_by=p_actor_id::text,updated_at=now()
   WHERE tenant_id=p_tenant_id AND id=q.id;
 INSERT INTO public.sales_quote_status_history(tenant_id,quote_id,quote_version_id,from_status,to_status,
   actor_id,actor_type,note) VALUES(p_tenant_id,q.id,v.id,'accepted','converted',
    p_actor_id::text,p_actor_kind,'Commercial sale confirmed');
 IF q.opportunity_id IS NOT NULL THEN
    SELECT * INTO won_stage FROM public.opportunity_stage
      WHERE tenant_id=p_tenant_id AND is_active AND is_won
      ORDER BY position,id LIMIT 1;
    IF NOT FOUND THEN RAISE EXCEPTION 'an active won opportunity stage is required' USING ERRCODE='23514'; END IF;
    PERFORM 1 FROM public.opportunity
      WHERE tenant_id=p_tenant_id AND id=q.opportunity_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'linked opportunity not found' USING ERRCODE='P0002'; END IF;
    INSERT INTO public.opportunity_stage_history(tenant_id,opportunity_id,from_stage_id,to_stage_id,
      actor_kind,actor_id,note)
    SELECT p_tenant_id,o.id,o.stage_id,won_stage.id,p_actor_kind,p_actor_id,'Commercial sale confirmed'
      FROM public.opportunity o WHERE o.tenant_id=p_tenant_id AND o.id=q.opportunity_id;
    UPDATE public.opportunity SET stage_id=won_stage.id,loss_reason_id=NULL,
      value_minor=v.gross_minor,currency=v.currency,version=version+1,updated_at=now()
      WHERE tenant_id=p_tenant_id AND id=q.opportunity_id;
   INSERT INTO public.opportunity_activity(tenant_id,opportunity_id,organization_id,actor_kind,actor_id,
     action,summary,metadata)
   SELECT p_tenant_id,o.id,o.organization_id,p_actor_kind,p_actor_id,'sale.confirmed',
     'Quote converted to a commercial sale',jsonb_build_object('quoteId',q.id,'saleId',sale.id)
   FROM public.opportunity o WHERE o.tenant_id=p_tenant_id AND o.id=q.opportunity_id;
 END IF;
 RETURN jsonb_build_object('saleId',sale.id,'idempotent',false);
END $$;

CREATE OR REPLACE FUNCTION public.move_sales_commercial_allocation(
 p_tenant_id uuid,p_allocation_id uuid,p_kind text,p_places integer,p_idempotency_key text,
 p_reason text,p_actor_kind text,p_actor_id uuid
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE a public.sales_commercial_allocation%ROWTYPE; t record; existing uuid;
BEGIN
 IF auth.role()<>'service_role' THEN RAISE EXCEPTION 'service role required' USING ERRCODE='42501'; END IF;
 IF p_tenant_id IS NULL OR p_allocation_id IS NULL OR p_kind NOT IN ('released','cancelled')
   OR p_places<=0 OR p_actor_id IS NULL OR p_actor_kind NOT IN ('tenant_user','member')
   OR length(btrim(COALESCE(p_idempotency_key,''))) NOT BETWEEN 1 AND 200
 THEN RAISE EXCEPTION 'invalid movement' USING ERRCODE='22023'; END IF;
 SELECT id INTO existing FROM public.sales_commercial_allocation_movement
   WHERE tenant_id=p_tenant_id AND allocation_id=p_allocation_id AND idempotency_key=p_idempotency_key;
 IF FOUND THEN RETURN jsonb_build_object('movementId',existing,'idempotent',true); END IF;
 SELECT * INTO a FROM public.sales_commercial_allocation
   WHERE tenant_id=p_tenant_id AND id=p_allocation_id FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'allocation not found' USING ERRCODE='P0002'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(
   CASE WHEN a.event_reference_kind='complex' THEN 'cx:' ELSE '' END
     ||a.event_id::text||':'||a.ticket_type_id,0));
  SELECT id INTO existing FROM public.sales_commercial_allocation_movement
    WHERE tenant_id=p_tenant_id AND allocation_id=p_allocation_id AND idempotency_key=p_idempotency_key;
  IF FOUND THEN RETURN jsonb_build_object('movementId',existing,'idempotent',true); END IF;
 SELECT * INTO t FROM public.sales_commercial_allocation_totals WHERE allocation_id=a.id;
 IF t.remaining-p_places<t.named+t.reserved THEN
   RAISE EXCEPTION 'release cannot reduce allocation below named and reserved places' USING ERRCODE='23514';
 END IF;
 INSERT INTO public.sales_commercial_allocation_movement(tenant_id,allocation_id,movement_kind,places,
   idempotency_key,actor_kind,actor_id,reason)
 VALUES(p_tenant_id,a.id,p_kind,p_places,p_idempotency_key,p_actor_kind,p_actor_id,p_reason)
 RETURNING id INTO existing;
 RETURN jsonb_build_object('movementId',existing,'idempotent',false);
END $$;

CREATE OR REPLACE FUNCTION public.release_sales_commercial_allocation(
 p_tenant_id uuid,p_allocation_id uuid,p_places integer,p_idempotency_key text,
 p_reason text,p_actor_kind text,p_actor_id uuid
) RETURNS jsonb
LANGUAGE sql SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT public.move_sales_commercial_allocation(
   p_tenant_id,p_allocation_id,'released',p_places,p_idempotency_key,
   p_reason,p_actor_kind,p_actor_id);
$$;

CREATE OR REPLACE FUNCTION public.cancel_sales_commercial_allocation(
 p_tenant_id uuid,p_allocation_id uuid,p_places integer,p_idempotency_key text,
 p_reason text,p_actor_kind text,p_actor_id uuid
) RETURNS jsonb
LANGUAGE sql SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT public.move_sales_commercial_allocation(
   p_tenant_id,p_allocation_id,'cancelled',p_places,p_idempotency_key,
   p_reason,p_actor_kind,p_actor_id);
$$;

CREATE OR REPLACE FUNCTION public.reconcile_sales_commercial_booking(
 p_tenant_id uuid,p_allocation_id uuid,p_booking_kind text,p_booking_id uuid,
 p_designation text,p_places integer,p_idempotency_key text,p_actor_kind text,p_actor_id uuid
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE a public.sales_commercial_allocation%ROWTYPE; t record; snap jsonb; existing uuid;
BEGIN
 IF auth.role()<>'service_role' THEN RAISE EXCEPTION 'service role required' USING ERRCODE='42501'; END IF;
 IF p_tenant_id IS NULL OR p_allocation_id IS NULL OR p_booking_kind NOT IN ('simple','complex')
   OR p_designation NOT IN ('named','reserved') OR p_places<>1 OR p_actor_id IS NULL
   OR p_actor_kind NOT IN ('tenant_user','member')
   OR length(btrim(COALESCE(p_idempotency_key,''))) NOT BETWEEN 1 AND 200
 THEN RAISE EXCEPTION 'invalid booking reconciliation' USING ERRCODE='22023'; END IF;
 SELECT id INTO existing FROM public.sales_commercial_allocation_movement
   WHERE tenant_id=p_tenant_id AND allocation_id=p_allocation_id AND idempotency_key=p_idempotency_key;
 IF FOUND THEN RETURN jsonb_build_object('movementId',existing,'idempotent',true); END IF;
 IF p_booking_kind='simple' THEN
   SELECT to_jsonb(b) INTO snap FROM public.booking b
    WHERE b.tenant_id=p_tenant_id AND b.id=p_booking_id AND b.status='confirmed' FOR UPDATE;
 ELSE
   SELECT to_jsonb(b) INTO snap FROM public.complex_event_booking b
    WHERE b.tenant_id=p_tenant_id AND b.id=p_booking_id AND b.status='confirmed' FOR UPDATE;
 END IF;
 IF snap IS NULL THEN RAISE EXCEPTION 'matching confirmed booking not found' USING ERRCODE='P0002'; END IF;
 SELECT * INTO a FROM public.sales_commercial_allocation
   WHERE tenant_id=p_tenant_id AND id=p_allocation_id FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'allocation not found' USING ERRCODE='P0002'; END IF;
 IF p_booking_kind<>a.event_reference_kind THEN
   RAISE EXCEPTION 'booking kind does not match allocation event kind' USING ERRCODE='23514';
 END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(
   CASE WHEN a.event_reference_kind='complex' THEN 'cx:' ELSE '' END||a.event_id::text||':'||a.ticket_type_id,0));
  SELECT id INTO existing FROM public.sales_commercial_allocation_movement
    WHERE tenant_id=p_tenant_id AND allocation_id=p_allocation_id AND idempotency_key=p_idempotency_key;
  IF FOUND THEN RETURN jsonb_build_object('movementId',existing,'idempotent',true); END IF;
 IF EXISTS (
   SELECT 1 FROM public.sales_commercial_allocation_booking
   WHERE tenant_id=p_tenant_id AND booking_kind=p_booking_kind AND booking_id=p_booking_id
 ) THEN
   RAISE EXCEPTION 'booking is already reconciled to an allocation' USING ERRCODE='23505';
 END IF;
 IF snap->>'event_id'<>a.event_id::text OR snap->>'ticket_class_id'<>a.ticket_type_id THEN
   RAISE EXCEPTION 'booking does not match allocation event and ticket' USING ERRCODE='23514';
 END IF;
 SELECT * INTO t FROM public.sales_commercial_allocation_totals WHERE allocation_id=a.id;
 IF t.named+t.reserved+p_places>t.remaining THEN
   RAISE EXCEPTION 'designation exceeds remaining allocation' USING ERRCODE='23514';
 END IF;
 INSERT INTO public.sales_commercial_allocation_booking(tenant_id,allocation_id,booking_kind,booking_id,
   places,designation,booking_snapshot)
 VALUES(p_tenant_id,a.id,p_booking_kind,p_booking_id,p_places,p_designation,snap);
 INSERT INTO public.sales_commercial_allocation_movement(tenant_id,allocation_id,movement_kind,places,
   idempotency_key,actor_kind,actor_id,metadata)
 VALUES(p_tenant_id,a.id,p_designation,p_places,p_idempotency_key,p_actor_kind,p_actor_id,
   jsonb_build_object('bookingKind',p_booking_kind,'bookingId',p_booking_id))
 RETURNING id INTO existing;
 RETURN jsonb_build_object('movementId',existing,'idempotent',false);
END $$;

CREATE OR REPLACE FUNCTION public.unreconcile_sales_commercial_booking(
 p_tenant_id uuid,p_booking_kind text,p_booking_id uuid,p_idempotency_key text,
 p_actor_kind text,p_actor_id uuid
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE link public.sales_commercial_allocation_booking%ROWTYPE; a public.sales_commercial_allocation%ROWTYPE;
DECLARE movement_id uuid; movement_kind text;
BEGIN
 IF auth.role()<>'service_role' THEN RAISE EXCEPTION 'service role required' USING ERRCODE='42501'; END IF;
 IF p_booking_kind NOT IN ('simple','complex') OR p_booking_id IS NULL
   OR p_actor_kind NOT IN ('tenant_user','member','system')
   OR length(btrim(COALESCE(p_idempotency_key,''))) NOT BETWEEN 1 AND 200
 THEN RAISE EXCEPTION 'invalid booking unreconciliation' USING ERRCODE='22023'; END IF;
 SELECT * INTO link FROM public.sales_commercial_allocation_booking
   WHERE tenant_id=p_tenant_id AND booking_kind=p_booking_kind AND booking_id=p_booking_id;
 IF NOT FOUND THEN RETURN jsonb_build_object('unreconciled',false,'reason','not_linked'); END IF;
 SELECT * INTO a FROM public.sales_commercial_allocation
   WHERE tenant_id=p_tenant_id AND id=link.allocation_id FOR SHARE;
 PERFORM pg_advisory_xact_lock(hashtextextended(
   CASE WHEN a.event_reference_kind='complex' THEN 'cx:' ELSE '' END||a.event_id::text||':'||a.ticket_type_id,0));
 SELECT id INTO movement_id FROM public.sales_commercial_allocation_movement
   WHERE tenant_id=p_tenant_id AND allocation_id=a.id AND idempotency_key=p_idempotency_key;
 IF FOUND THEN RETURN jsonb_build_object('movementId',movement_id,'idempotent',true,'unreconciled',true); END IF;
 SELECT m.id INTO movement_id
   FROM public.sales_commercial_allocation_movement m
   WHERE m.tenant_id=p_tenant_id AND m.allocation_id=a.id
     AND m.movement_kind IN ('unnamed','unreserved')
     AND m.metadata->>'bookingKind'=p_booking_kind
     AND m.metadata->>'bookingId'=p_booking_id::text
   LIMIT 1;
 IF FOUND THEN RETURN jsonb_build_object('movementId',movement_id,'idempotent',true,'unreconciled',true); END IF;
 movement_kind:=CASE WHEN link.designation='named' THEN 'unnamed' ELSE 'unreserved' END;
 INSERT INTO public.sales_commercial_allocation_movement(tenant_id,allocation_id,movement_kind,places,
   idempotency_key,actor_kind,actor_id,metadata)
 VALUES(p_tenant_id,a.id,movement_kind,link.places,p_idempotency_key,p_actor_kind,p_actor_id,
   jsonb_build_object('bookingKind',p_booking_kind,'bookingId',p_booking_id))
 RETURNING id INTO movement_id;
 RETURN jsonb_build_object('movementId',movement_id,'idempotent',false,'unreconciled',true);
END $$;

CREATE OR REPLACE FUNCTION public.cancel_event_booking_with_allocation(
 p_tenant_id uuid,p_booking_kind text,p_booking_id uuid,p_idempotency_key text,
 p_actor_kind text,p_actor_id uuid
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE link public.sales_commercial_allocation_booking%ROWTYPE;
DECLARE a public.sales_commercial_allocation%ROWTYPE; previous_status text; movement jsonb; was_already_cancelled boolean;
BEGIN
 IF auth.role()<>'service_role' THEN RAISE EXCEPTION 'service role required' USING ERRCODE='42501'; END IF;
 IF p_tenant_id IS NULL OR p_booking_kind NOT IN ('simple','complex') OR p_booking_id IS NULL
   OR p_actor_kind NOT IN ('tenant_user','member','system')
   OR p_actor_id IS NULL OR length(btrim(COALESCE(p_idempotency_key,''))) NOT BETWEEN 1 AND 200
 THEN RAISE EXCEPTION 'invalid booking cancellation' USING ERRCODE='22023'; END IF;

 IF p_booking_kind='simple' THEN
   SELECT status INTO previous_status FROM public.booking
    WHERE tenant_id=p_tenant_id AND id=p_booking_id FOR UPDATE;
 ELSE
   SELECT status INTO previous_status FROM public.complex_event_booking
    WHERE tenant_id=p_tenant_id AND id=p_booking_id FOR UPDATE;
 END IF;
 IF NOT FOUND THEN RAISE EXCEPTION 'booking not found' USING ERRCODE='P0002'; END IF;
 was_already_cancelled:=previous_status='cancelled';

 SELECT * INTO link FROM public.sales_commercial_allocation_booking
  WHERE tenant_id=p_tenant_id AND booking_kind=p_booking_kind AND booking_id=p_booking_id;
 IF FOUND THEN
   SELECT * INTO a FROM public.sales_commercial_allocation
    WHERE tenant_id=p_tenant_id AND id=link.allocation_id FOR SHARE;
   PERFORM pg_advisory_xact_lock(hashtextextended(
    CASE WHEN a.event_reference_kind='complex' THEN 'cx:' ELSE '' END||a.event_id::text||':'||a.ticket_type_id,0));
 END IF;

 IF NOT was_already_cancelled THEN
   IF p_booking_kind='simple' THEN
     UPDATE public.booking SET status='cancelled'
      WHERE tenant_id=p_tenant_id AND id=p_booking_id;
   ELSE
     UPDATE public.complex_event_booking SET status='cancelled'
      WHERE tenant_id=p_tenant_id AND id=p_booking_id;
   END IF;
 END IF;

 IF link.id IS NOT NULL THEN
   movement:=public.unreconcile_sales_commercial_booking(
    p_tenant_id,p_booking_kind,p_booking_id,p_idempotency_key,p_actor_kind,p_actor_id);
 ELSE
   movement:=jsonb_build_object('unreconciled',false,'reason','not_linked');
 END IF;
 RETURN jsonb_build_object('bookingId',p_booking_id,'previousStatus',previous_status,
  'alreadyCancelled',was_already_cancelled,'movement',movement);
END $$;

-- Compatibility replacements keep ordinary pre-check/post-verify registration
-- semantics, adding only unused commercial places to the capacity calculation.
CREATE OR REPLACE FUNCTION public.check_oneoff_ticket_capacity(
 p_event_id uuid,p_ticket_class_id text,p_requested integer DEFAULT 1,p_booking_ids uuid[] DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE s jsonb; last_created timestamptz; last_id uuid; rank integer;
BEGIN
 s:=public.sales_capacity_state('simple',p_event_id,p_ticket_class_id);
 IF COALESCE((s->>'unlimited')::boolean,false) THEN RETURN s; END IF;
 IF p_booking_ids IS NULL THEN
   RETURN s||jsonb_build_object('sold',(s->>'used')::integer,
     'ok',(s->>'used')::integer+greatest(COALESCE(p_requested,1),0)<=(s->>'max')::integer);
 END IF;
 SELECT created_at,id INTO last_created,last_id FROM public.booking
   WHERE id=ANY(p_booking_ids) AND status='confirmed' ORDER BY created_at DESC,id DESC LIMIT 1;
 IF NOT FOUND THEN RETURN s||jsonb_build_object('ok',true); END IF;
 SELECT count(*)+(s->>'commercialUnused')::integer INTO rank FROM public.booking
   WHERE event_id=p_event_id AND ticket_class_id=p_ticket_class_id AND status='confirmed'
     AND (created_at,id)<=(last_created,last_id);
 IF rank<=(s->>'max')::integer THEN RETURN s||jsonb_build_object('ok',true,'sold',rank); END IF;
 DELETE FROM public.booking WHERE id=ANY(p_booking_ids);
 RETURN s||jsonb_build_object('ok',false,'sold',rank);
END $$;

CREATE OR REPLACE FUNCTION public.check_complex_event_ticket_capacity(
 p_event_id uuid,p_ticket_class_id text,p_requested integer DEFAULT 1,p_booking_ids uuid[] DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE s jsonb; last_created timestamptz; last_id uuid; rank integer;
BEGIN
 s:=public.sales_capacity_state('complex',p_event_id,p_ticket_class_id);
 IF COALESCE((s->>'unlimited')::boolean,false) THEN RETURN s; END IF;
 IF p_booking_ids IS NULL THEN
   RETURN s||jsonb_build_object('sold',(s->>'used')::integer,
     'ok',(s->>'used')::integer+greatest(COALESCE(p_requested,1),0)<=(s->>'max')::integer);
 END IF;
 SELECT created_at,id INTO last_created,last_id FROM public.complex_event_booking
   WHERE id=ANY(p_booking_ids) AND status='confirmed' ORDER BY created_at DESC,id DESC LIMIT 1;
 IF NOT FOUND THEN RETURN s||jsonb_build_object('ok',true); END IF;
 SELECT count(*)+(s->>'commercialUnused')::integer INTO rank FROM public.complex_event_booking
   WHERE event_id=p_event_id AND ticket_class_id=p_ticket_class_id AND status='confirmed'
     AND (created_at,id)<=(last_created,last_id);
 IF rank<=(s->>'max')::integer THEN RETURN s||jsonb_build_object('ok',true,'sold',rank); END IF;
 DELETE FROM public.complex_event_booking WHERE id=ANY(p_booking_ids);
 RETURN s||jsonb_build_object('ok',false,'sold',rank);
END $$;

ALTER TABLE public.sales_commercial_sale ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sales_commercial_allocation ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sales_commercial_allocation_movement ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sales_commercial_allocation_booking ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.sales_commercial_sale,public.sales_commercial_allocation,
 public.sales_commercial_allocation_movement,public.sales_commercial_allocation_booking
 FROM PUBLIC,anon,authenticated;
REVOKE ALL ON public.sales_commercial_allocation_totals FROM PUBLIC,anon,authenticated;
GRANT SELECT ON public.sales_commercial_sale,public.sales_commercial_allocation,
 public.sales_commercial_allocation_movement,public.sales_commercial_allocation_booking,
 public.sales_commercial_allocation_totals TO service_role;
CREATE POLICY sales_commercial_sale_service ON public.sales_commercial_sale FOR SELECT TO service_role USING(true);
CREATE POLICY sales_commercial_allocation_service ON public.sales_commercial_allocation FOR SELECT TO service_role USING(true);
CREATE POLICY sales_commercial_movement_service ON public.sales_commercial_allocation_movement FOR SELECT TO service_role USING(true);
CREATE POLICY sales_commercial_booking_service ON public.sales_commercial_allocation_booking FOR SELECT TO service_role USING(true);

REVOKE ALL ON FUNCTION public.guard_sales_commercial_append_only(),
 public.sales_capacity_state(text,uuid,text),
 public.confirm_sales_quote_sale(uuid,uuid,integer,text,text,uuid),
 public.move_sales_commercial_allocation(uuid,uuid,text,integer,text,text,text,uuid),
 public.release_sales_commercial_allocation(uuid,uuid,integer,text,text,text,uuid),
 public.cancel_sales_commercial_allocation(uuid,uuid,integer,text,text,text,uuid),
 public.reconcile_sales_commercial_booking(uuid,uuid,text,uuid,text,integer,text,text,uuid),
 public.unreconcile_sales_commercial_booking(uuid,text,uuid,text,text,uuid),
 public.cancel_event_booking_with_allocation(uuid,text,uuid,text,text,uuid)
 FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.sales_capacity_state(text,uuid,text),
 public.confirm_sales_quote_sale(uuid,uuid,integer,text,text,uuid),
 public.move_sales_commercial_allocation(uuid,uuid,text,integer,text,text,text,uuid),
 public.release_sales_commercial_allocation(uuid,uuid,integer,text,text,text,uuid),
 public.cancel_sales_commercial_allocation(uuid,uuid,integer,text,text,text,uuid),
 public.reconcile_sales_commercial_booking(uuid,uuid,text,uuid,text,integer,text,text,uuid),
 public.unreconcile_sales_commercial_booking(uuid,text,uuid,text,text,uuid),
 public.cancel_event_booking_with_allocation(uuid,text,uuid,text,text,uuid)
 TO service_role;

-- Existing registration callers execute these as ordinary authenticated users.
-- They remain invoker functions and retain their prior grants.
GRANT EXECUTE ON FUNCTION public.check_oneoff_ticket_capacity(uuid,text,integer,uuid[]),
 public.check_complex_event_ticket_capacity(uuid,text,integer,uuid[])
 TO PUBLIC,anon,authenticated,service_role;