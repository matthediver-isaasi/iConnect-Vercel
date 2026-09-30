-- Task #1758: Count-based ticket availability — atomic capacity guard for standard events.
--
-- Standard event tickets store an admin-set maximum in
-- event.pricing_config -> 'ticket_classes' [] -> 'available_count'. Availability
-- is derived from the actual count of status='confirmed' bookings per
-- ticket_class_id; available_count is treated as a fixed capacity and is never
-- mutated by bookings.
--
-- This function provides the server-side race guard so two concurrent checkouts
-- cannot both claim the last ticket. All capacity decisions for a given
-- (event, ticket class) are serialized with a transaction-scoped advisory lock.
--
-- Two modes:
--   * PRE-CHECK  (p_booking_ids IS NULL): is there room for p_requested more
--     confirmed bookings? Returns ok = (confirmed + requested) <= max.
--   * POST-VERIFY (p_booking_ids provided): our rows are already inserted
--     (status='confirmed'); decide whether they fit using a stable
--     (created_at, id) ordering. A booking fits iff the global rank of its LAST
--     seat is within the maximum. If it does not fit, the function DELETES our
--     rows under the lock (the loser of the race) so the freed capacity is
--     immediately visible to any waiting checkout, and returns ok = false.
--
-- Tickets that are unlimited / have no numeric maximum are never capped.
-- Idempotent: CREATE OR REPLACE.

create or replace function check_oneoff_ticket_capacity(
  p_event_id uuid,
  p_ticket_class_id text,
  p_requested integer default 1,
  p_booking_ids uuid[] default null
)
returns jsonb
language plpgsql
as $$
declare
  v_lock_key bigint;
  v_tc jsonb;
  v_max integer;
  v_sold integer;
  v_rank integer;
  v_our_count integer;
  v_max_created timestamptz;
  v_max_id uuid;
begin
  -- No ticket class context => nothing to cap.
  if p_event_id is null or p_ticket_class_id is null then
    return jsonb_build_object('ok', true, 'unlimited', true, 'reason', 'no_ticket_class');
  end if;

  -- Serialize all capacity decisions for this (event, ticket class).
  v_lock_key := hashtextextended(p_event_id::text || ':' || p_ticket_class_id, 0);
  perform pg_advisory_xact_lock(v_lock_key);

  -- Resolve the admin-set maximum (capacity) from the event pricing_config.
  select tc into v_tc
  from event e
  cross join lateral jsonb_array_elements(
    case
      when jsonb_typeof(e.pricing_config -> 'ticket_classes') = 'array'
        then e.pricing_config -> 'ticket_classes'
      else '[]'::jsonb
    end
  ) tc
  where e.id = p_event_id
    and tc ->> 'id' = p_ticket_class_id
  limit 1;

  -- No matching ticket class, unlimited flag, or no maximum => no cap.
  if v_tc is null
     or coalesce((v_tc ->> 'is_unlimited_tickets')::boolean, false)
     or v_tc ->> 'available_count' is null
     or btrim(v_tc ->> 'available_count') = ''
  then
    return jsonb_build_object('ok', true, 'unlimited', true);
  end if;

  begin
    v_max := (v_tc ->> 'available_count')::integer;
  exception when others then
    -- Non-numeric maximum: treat as no enforceable cap rather than blocking.
    return jsonb_build_object('ok', true, 'unlimited', true, 'reason', 'non_numeric_max');
  end;

  if p_booking_ids is null then
    -- PRE-CHECK: is there room for p_requested more confirmed bookings?
    select count(*) into v_sold
    from booking
    where event_id = p_event_id
      and ticket_class_id = p_ticket_class_id
      and status = 'confirmed';

    return jsonb_build_object(
      'ok', (v_sold + greatest(coalesce(p_requested, 1), 0)) <= v_max,
      'sold', v_sold,
      'max', v_max,
      'unlimited', false
    );
  end if;

  -- POST-VERIFY: how many of our rows are confirmed?
  select count(*) into v_our_count
  from booking
  where id = any(p_booking_ids)
    and status = 'confirmed';

  if v_our_count = 0 then
    return jsonb_build_object('ok', true, 'sold', 0, 'max', v_max, 'unlimited', false);
  end if;

  -- Our LAST seat by stable ordering.
  select created_at, id into v_max_created, v_max_id
  from booking
  where id = any(p_booking_ids)
    and status = 'confirmed'
  order by created_at desc, id desc
  limit 1;

  -- Global rank of our last seat (counts ours and any other confirmed rows
  -- ordered at or before it). Fits iff that rank is within the maximum.
  select count(*) into v_rank
  from booking
  where event_id = p_event_id
    and ticket_class_id = p_ticket_class_id
    and status = 'confirmed'
    and (created_at, id) <= (v_max_created, v_max_id);

  if v_rank <= v_max then
    return jsonb_build_object('ok', true, 'sold', v_rank, 'max', v_max, 'unlimited', false);
  end if;

  -- Over capacity: this booking lost the race. Remove our rows under the lock.
  delete from booking where id = any(p_booking_ids);

  return jsonb_build_object('ok', false, 'sold', v_rank, 'max', v_max, 'unlimited', false);
end;
$$;
