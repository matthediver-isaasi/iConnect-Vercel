CREATE OR REPLACE FUNCTION atomic_decrement_complex_event_seats(
  p_event_id UUID,
  p_count INTEGER
)
RETURNS INTEGER AS $$
DECLARE
  new_seats INTEGER;
BEGIN
  IF p_count <= 0 THEN
    RAISE EXCEPTION 'p_count must be a positive integer, got %', p_count;
  END IF;

  UPDATE complex_event
  SET available_seats = available_seats - p_count
  WHERE id = p_event_id
    AND available_seats >= p_count
  RETURNING available_seats INTO new_seats;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Insufficient seats for complex event %', p_event_id;
  END IF;

  RETURN new_seats;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION atomic_decrement_ticket_class_seats(
  p_ticket_class_id UUID,
  p_count INTEGER
)
RETURNS INTEGER AS $$
DECLARE
  new_count INTEGER;
BEGIN
  IF p_count <= 0 THEN
    RAISE EXCEPTION 'p_count must be a positive integer, got %', p_count;
  END IF;

  UPDATE complex_event_ticket_class
  SET available_count = available_count - p_count
  WHERE id = p_ticket_class_id
    AND available_count >= p_count
  RETURNING available_count INTO new_count;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Insufficient ticket class seats for ticket class %', p_ticket_class_id;
  END IF;

  RETURN new_count;
END;
$$ LANGUAGE plpgsql;
