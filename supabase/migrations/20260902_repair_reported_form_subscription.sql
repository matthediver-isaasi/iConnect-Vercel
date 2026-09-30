-- Narrow, idempotent repair for the reported form submission whose member
-- creation succeeded before communication finalization was durable.
DO $$
DECLARE
  v_submission_id constant uuid := '68097414-bb9c-4cca-a694-f1d107ec0d81';
  v_submission form_submission%ROWTYPE;
  v_email text;
  v_category_ids uuid[];
  v_states boolean[];
BEGIN
  SELECT *
  INTO v_submission
  FROM form_submission
  WHERE id = v_submission_id;

  IF NOT FOUND THEN
    RETURN;
  END IF;
  IF v_submission.created_member_id IS NULL THEN
    RAISE EXCEPTION 'reported form submission has no resolved member';
  END IF;

  SELECT lower(trim(email))
  INTO v_email
  FROM member
  WHERE id = v_submission.created_member_id
    AND tenant_id = v_submission.tenant_id;
  IF v_email IS NULL THEN
    RAISE EXCEPTION 'reported form submission member is missing or cross-tenant';
  END IF;

  SELECT array_agg(id ORDER BY name), array_agg(true ORDER BY name)
  INTO v_category_ids, v_states
  FROM communication_category
  WHERE tenant_id = v_submission.tenant_id
    AND is_active = true
    AND name IN ('Newsletter test', 'Event Updates');

  IF cardinality(coalesce(v_category_ids, array[]::uuid[])) <> 2 THEN
    RAISE EXCEPTION 'expected exactly Newsletter test and Event Updates for reported submission tenant';
  END IF;

  PERFORM set_form_communication_preference_state(
    v_submission.tenant_id,
    v_email,
    v_submission.created_member_id,
    v_submission.form_id,
    null,
    null,
    v_category_ids,
    v_states
  );

  IF (
    SELECT count(*)
    FROM member_communication_preference
    WHERE tenant_id = v_submission.tenant_id
      AND member_id = v_submission.created_member_id
      AND category_id = ANY(v_category_ids)
      AND is_subscribed = true
  ) <> 2 THEN
    RAISE EXCEPTION 'reported form submission communication repair verification failed';
  END IF;

  UPDATE form_submission
  SET communication_finalization_state = jsonb_build_object(
    'version', 1,
    'status', 'completed',
    'member_id', v_submission.created_member_id,
    'email', v_email,
    'selections', (
      SELECT jsonb_agg(jsonb_build_object(
        'category_id', category_id,
        'is_subscribed', true
      ) ORDER BY category_id)
      FROM unnest(v_category_ids) category_id
    ),
    'attempts', 1,
    'completed_at', now(),
    'error', null
  )
  WHERE id = v_submission_id;
END;
$$;