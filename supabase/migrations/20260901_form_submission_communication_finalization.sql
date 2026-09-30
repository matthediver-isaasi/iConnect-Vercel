-- Durable, replayable completion state for form communication preferences.
ALTER TABLE form_submission
  ADD COLUMN IF NOT EXISTS communication_finalization_state jsonb;

COMMENT ON COLUMN form_submission.communication_finalization_state IS
  'Immutable communication selections plus pending/completed/failed replay state for public form submission finalization.';

CREATE INDEX IF NOT EXISTS idx_form_submission_communication_finalization_pending
  ON form_submission ((communication_finalization_state->>'status'))
  WHERE communication_finalization_state->>'status' IN ('pending', 'failed');

CREATE OR REPLACE FUNCTION promote_form_communication_finalization(
  p_submission_id uuid,
  p_member_id uuid,
  p_snapshot jsonb
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_state jsonb;
BEGIN
  IF p_submission_id IS NULL
    OR p_snapshot IS NULL
    OR p_snapshot->>'status' NOT IN ('pending', 'completed')
    OR coalesce((p_snapshot->>'member_id')::uuid, p_member_id)
       IS DISTINCT FROM p_member_id
    OR (
      p_snapshot->>'status' = 'completed'
      AND jsonb_array_length(coalesce(p_snapshot->'selections', '[]'::jsonb)) <> 0
    )
  THEN
    RAISE EXCEPTION 'invalid communication finalization promotion';
  END IF;

  IF p_member_id IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM form_submission submission
    JOIN member
      ON member.id = p_member_id
      AND member.tenant_id = submission.tenant_id
    WHERE submission.id = p_submission_id
  ) THEN
    RAISE EXCEPTION 'communication finalization member is missing or cross-tenant';
  END IF;

  UPDATE form_submission
  SET created_member_id = coalesce(p_member_id, created_member_id),
      communication_finalization_state = CASE
        WHEN communication_finalization_state->>'status' = 'awaiting_member'
          THEN p_snapshot
        ELSE communication_finalization_state
      END
  WHERE id = p_submission_id
    AND (
      (
        communication_finalization_state->>'status' = 'awaiting_member'
        AND p_snapshot->>'status' = 'pending'
      )
      OR (
        communication_finalization_state->>'status' = 'completed'
        AND p_snapshot->>'status' = 'completed'
      )
    )
  RETURNING communication_finalization_state INTO v_state;

  IF v_state IS NULL THEN
    SELECT communication_finalization_state
    INTO v_state
    FROM form_submission
    WHERE id = p_submission_id;
  END IF;
  RETURN v_state;
END;
$$;

CREATE OR REPLACE FUNCTION claim_form_communication_finalization(
  p_submission_id uuid,
  p_expected_status text,
  p_expected_attempts integer,
  p_owner_token uuid
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_state jsonb;
BEGIN
  UPDATE form_submission
  SET communication_finalization_state =
    communication_finalization_state
    || jsonb_build_object(
      'status', 'processing',
      'attempts', coalesce((communication_finalization_state->>'attempts')::integer, 0) + 1,
      'owner_token', p_owner_token,
      'last_attempt_at', now(),
      'lease_expires_at', now() + interval '2 minutes',
      'error', null
    )
  WHERE id = p_submission_id
    AND (
      (
        communication_finalization_state->>'status' = p_expected_status
        AND coalesce((communication_finalization_state->>'attempts')::integer, 0) = p_expected_attempts
        AND p_expected_status IN ('pending', 'failed')
      )
      OR (
        communication_finalization_state->>'status' = 'processing'
        AND (communication_finalization_state->>'lease_expires_at')::timestamptz < now()
      )
    )
  RETURNING communication_finalization_state INTO v_state;
  RETURN v_state;
END;
$$;

CREATE OR REPLACE FUNCTION finish_form_communication_finalization(
  p_submission_id uuid,
  p_owner_token uuid,
  p_status text,
  p_error jsonb,
  p_member_id uuid
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_state jsonb;
BEGIN
  IF p_status NOT IN ('completed', 'failed') THEN
    RAISE EXCEPTION 'invalid communication finalization status';
  END IF;

  UPDATE form_submission
  SET communication_finalization_state =
    (communication_finalization_state - 'owner_token' - 'lease_expires_at')
    || jsonb_build_object(
      'status', p_status,
      'member_id', p_member_id,
      'error', p_error
    )
    || CASE
      WHEN p_status = 'completed' THEN jsonb_build_object('completed_at', now())
      ELSE jsonb_build_object('failed_at', now())
    END
  WHERE id = p_submission_id
    AND communication_finalization_state->>'status' = 'processing'
    AND communication_finalization_state->>'owner_token' = p_owner_token::text
  RETURNING communication_finalization_state INTO v_state;
  RETURN v_state;
END;
$$;

REVOKE ALL ON FUNCTION claim_form_communication_finalization(uuid, text, integer, uuid)
  FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION claim_form_communication_finalization(uuid, text, integer, uuid)
  TO service_role;
REVOKE ALL ON FUNCTION finish_form_communication_finalization(uuid, uuid, text, jsonb, uuid)
  FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION finish_form_communication_finalization(uuid, uuid, text, jsonb, uuid)
  TO service_role;
REVOKE ALL ON FUNCTION promote_form_communication_finalization(uuid, uuid, jsonb)
  FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION promote_form_communication_finalization(uuid, uuid, jsonb)
  TO service_role;