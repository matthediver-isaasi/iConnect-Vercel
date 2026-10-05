-- PREPARED ONLY: requires purchase evidence migration and finalizer integration.
BEGIN;
CREATE OR REPLACE FUNCTION public.insert_public_ticket_booking_batch(
  p_purchase_id uuid, p_rows jsonb
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  purchase public.public_ticket_member_purchase%ROWTYPE;
  source_table text;
  event_table text;
  row_data jsonb;
  stored_row jsonb;
  result_rows jsonb := '[]'::jsonb;
  ids uuid[] := '{}';
  column_names text;
  select_names text;
  ticket record;
  capacity jsonb;
  event_row jsonb;
  expected_count integer;
  row_index integer := 0;
  expected jsonb;
BEGIN
  SELECT p.* INTO purchase FROM public.public_ticket_member_purchase AS p
    WHERE p.id=p_purchase_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Purchase not found' USING ERRCODE='22023'; END IF;
  source_table := CASE purchase.event_kind WHEN 'simple' THEN 'booking' ELSE 'complex_event_booking' END;
  event_table := CASE purchase.event_kind WHEN 'simple' THEN 'event' ELSE 'complex_event' END;
  IF cardinality(purchase.booking_ids)>0 THEN
    EXECUTE format('SELECT coalesce(jsonb_agg(to_jsonb(b) ORDER BY array_position($1,b.id)),''[]''::jsonb) FROM public.%I b WHERE b.id=ANY($1) AND b.tenant_id=$2 AND b.status=''confirmed''',source_table)
      INTO result_rows USING purchase.booking_ids,purchase.tenant_id;
    IF jsonb_array_length(result_rows)<>cardinality(purchase.booking_ids) THEN
      RAISE EXCEPTION 'Purchase booking batch is no longer confirmed' USING ERRCODE='23514';
    END IF;
    RETURN result_rows;
  END IF;
  IF purchase.state<>'prepared' OR jsonb_typeof(p_rows) IS DISTINCT FROM 'array'
     OR jsonb_array_length(p_rows) NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'Invalid purchase batch' USING ERRCODE='22023';
  END IF;
  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'ticket_id',item.value->>'ticket_id','identity',attendee.value
  ) ORDER BY item.ordinality,attendee.ordinality),'[]'::jsonb)
  INTO expected
  FROM jsonb_array_elements(purchase.snapshot->'booking_items') WITH ORDINALITY item(value,ordinality)
  CROSS JOIN LATERAL jsonb_array_elements(item.value->'attendees') WITH ORDINALITY attendee(value,ordinality);
  expected_count:=jsonb_array_length(expected);
  IF expected_count<>jsonb_array_length(p_rows) THEN
    RAISE EXCEPTION 'Purchase batch does not match snapshot' USING ERRCODE='23514';
  END IF;
  FOR ticket IN SELECT value->>'ticket_class_id' AS id,count(*)::integer AS quantity
    FROM jsonb_array_elements(p_rows) GROUP BY value->>'ticket_class_id' ORDER BY value->>'ticket_class_id'
  LOOP
    capacity:=CASE purchase.event_kind
      WHEN 'simple' THEN public.check_oneoff_ticket_capacity(purchase.event_id,ticket.id,ticket.quantity,NULL)
      ELSE public.check_complex_event_ticket_capacity(purchase.event_id,ticket.id,ticket.quantity,NULL) END;
    IF capacity->>'ok' IS DISTINCT FROM 'true' THEN
      UPDATE public.public_ticket_member_purchase SET
        state=CASE WHEN stripe_payment_intent_id IS NULL THEN 'excluded' ELSE 'retryable' END,
        last_error_code='capacity_refund_pending',updated_at=now() WHERE id=purchase.id;
      RETURN jsonb_build_object('error','capacity_unavailable');
    END IF;
  END LOOP;
  EXECUTE format('SELECT to_jsonb(e) FROM public.%I e WHERE e.id=$1 AND e.tenant_id=$2 FOR UPDATE',event_table)
    INTO event_row USING purchase.event_id,purchase.tenant_id;
  IF event_row IS NULL OR event_row->>'event_state' IN ('closed','draft')
     OR event_row->>'status' IN ('closed','cancelling','cancelled') THEN
    UPDATE public.public_ticket_member_purchase SET
      state=CASE WHEN stripe_payment_intent_id IS NULL THEN 'excluded' ELSE 'retryable' END,
      last_error_code='capacity_refund_pending',updated_at=now() WHERE id=purchase.id;
    RETURN jsonb_build_object('error','capacity_unavailable');
  END IF;
  IF event_row->>'available_seats' IS NOT NULL
     AND NOT (purchase.event_kind='simple' AND coalesce((event_row->>'is_unlimited_registration')::boolean,false))
  THEN
    IF (event_row->>'available_seats')::integer<expected_count THEN
      UPDATE public.public_ticket_member_purchase SET
        state=CASE WHEN stripe_payment_intent_id IS NULL THEN 'excluded' ELSE 'retryable' END,
        last_error_code='capacity_refund_pending',updated_at=now() WHERE id=purchase.id;
      RETURN jsonb_build_object('error','capacity_unavailable');
    END IF;
    EXECUTE format('UPDATE public.%I SET available_seats=available_seats-$1 WHERE id=$2',event_table)
      USING expected_count,purchase.event_id;
  END IF;
  FOR row_data IN SELECT value FROM jsonb_array_elements(p_rows)
  LOOP
    IF row_data->>'ticket_class_id' IS DISTINCT FROM expected->row_index->>'ticket_id'
       OR public.normalize_public_ticket_email(row_data->>'attendee_email') IS DISTINCT FROM expected->row_index->'identity'->>'email'
       OR btrim(row_data->>'attendee_first_name') IS DISTINCT FROM expected->row_index->'identity'->>'first_name'
       OR btrim(row_data->>'attendee_last_name') IS DISTINCT FROM expected->row_index->'identity'->>'last_name'
       OR coalesce(row_data->>'payment_method','') NOT IN ('card','free')
       OR (row_data->>'payment_method'='card'
           AND (purchase.stripe_payment_intent_id IS NULL
                OR row_data->>'stripe_payment_intent_id' IS DISTINCT FROM purchase.stripe_payment_intent_id))
    THEN RAISE EXCEPTION 'Booking does not match purchase' USING ERRCODE='23514'; END IF;
    row_data:=row_data||jsonb_build_object(
      'id',gen_random_uuid(),'tenant_id',purchase.tenant_id,'event_id',purchase.event_id,
      'member_id',NULL,'organization_id',NULL,'status','confirmed','created_at',now()
    );
    -- Identifiers are quoted, table names are fixed above, values stay bound.
    -- Insert only supplied columns so unrelated database defaults remain intact.
    SELECT string_agg(format('%I',key),',' ORDER BY key),
           string_agg(format('r.%I',key),',' ORDER BY key)
      INTO column_names,select_names FROM jsonb_object_keys(row_data) key;
    EXECUTE format(
      'INSERT INTO public.%I (%s) SELECT %s FROM jsonb_populate_record(NULL::public.%I,$1) r RETURNING to_jsonb(%I.*)',
      source_table,column_names,select_names,source_table,source_table
    ) INTO stored_row USING row_data;
    ids:=array_append(ids,(stored_row->>'id')::uuid);
    result_rows:=result_rows||jsonb_build_array(stored_row);
    row_index:=row_index+1;
  END LOOP;
  UPDATE public.public_ticket_member_purchase SET booking_ids=ids,updated_at=now() WHERE id=purchase.id;
  RETURN result_rows;
END $$;
REVOKE ALL ON FUNCTION public.insert_public_ticket_booking_batch(uuid,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.insert_public_ticket_booking_batch(uuid,jsonb) TO service_role;
CREATE OR REPLACE FUNCTION public.public_ticket_member_creation_ready()
RETURNS boolean LANGUAGE sql STABLE
SET search_path=pg_catalog,public
AS $$ SELECT to_regprocedure('public.insert_public_ticket_booking_batch(uuid,jsonb)') IS NOT NULL
  AND to_regprocedure('public.provision_public_ticket_members(uuid)') IS NOT NULL
  AND to_regprocedure('public.lookup_public_ticket_member_emails(uuid,text[])') IS NOT NULL $$;
REVOKE ALL ON FUNCTION public.public_ticket_member_creation_ready() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.public_ticket_member_creation_ready() TO service_role;
NOTIFY pgrst, 'reload schema';
COMMIT;
