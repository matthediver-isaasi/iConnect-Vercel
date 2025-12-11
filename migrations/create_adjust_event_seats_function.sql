-- Create a function to atomically adjust event seats
-- This prevents race conditions when multiple bookings/cancellations happen simultaneously
-- Usage: SELECT adjust_event_seats('event-uuid', -2) to decrement by 2
--        SELECT adjust_event_seats('event-uuid', 1) to increment by 1
-- Returns the new seat count, or null if operation would go negative

CREATE OR REPLACE FUNCTION adjust_event_seats(
  p_event_id UUID,
  p_delta INTEGER
)
RETURNS INTEGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_current_seats INTEGER;
  v_new_seats INTEGER;
BEGIN
  -- Lock the row and get current seat count
  SELECT available_seats INTO v_current_seats
  FROM event
  WHERE id = p_event_id
  FOR UPDATE;
  
  -- If event not found, return null
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  
  -- If unlimited seats (null), no adjustment needed - return null to indicate unlimited
  IF v_current_seats IS NULL THEN
    RETURN NULL;
  END IF;
  
  -- Calculate new seat count
  v_new_seats := v_current_seats + p_delta;
  
  -- Prevent going below zero
  IF v_new_seats < 0 THEN
    RAISE EXCEPTION 'Insufficient seats available. Requested: %, Available: %', ABS(p_delta), v_current_seats;
  END IF;
  
  -- Perform the atomic update
  UPDATE event
  SET available_seats = v_new_seats
  WHERE id = p_event_id;
  
  RETURN v_new_seats;
END;
$$;
