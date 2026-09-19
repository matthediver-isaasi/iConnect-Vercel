-- Correct cas_form_monthly_card_state for the live JSONB processing_notes
-- column. Keep the deployed signature unchanged so existing finalizer clients
-- continue to resolve the same PostgREST RPC.
CREATE OR REPLACE FUNCTION public.cas_form_monthly_card_state(
  p_submission_id UUID,
  p_expected_payment_meta JSONB,
  p_next_state JSONB,
  p_remove_state BOOLEAN DEFAULT FALSE,
  p_expected_payment_status TEXT DEFAULT NULL,
  p_expected_state_status TEXT DEFAULT NULL,
  p_expect_state_absent BOOLEAN DEFAULT FALSE,
  p_expected_claimed_at TEXT DEFAULT NULL,
  p_expected_owner_token TEXT DEFAULT NULL,
  p_processing_notes TEXT DEFAULT NULL,
  p_write_processing_notes BOOLEAN DEFAULT FALSE
) RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_existing_notes JSONB;
  v_next_notes JSONB;
  v_note_message TEXT;
BEGIN
  IF p_submission_id IS NULL
     OR p_expected_payment_meta IS NULL
     OR (NOT p_remove_state AND (
       p_next_state IS NULL OR jsonb_typeof(p_next_state) <> 'object'
     ))
     OR (p_remove_state AND p_next_state IS NOT NULL) THEN
    RAISE EXCEPTION 'invalid monthly-card state CAS arguments'
      USING ERRCODE = '22023';
  END IF;

  IF p_write_processing_notes THEN
    SELECT submission.processing_notes
      INTO v_existing_notes
      FROM public.form_submission AS submission
     WHERE submission.id = p_submission_id
       FOR UPDATE;

    -- The canonical shape is an array of structured diagnostics. Preserve
    -- historical values of every known shape rather than replacing them.
    v_next_notes := CASE
      WHEN v_existing_notes IS NULL OR v_existing_notes = 'null'::JSONB
        THEN '[]'::JSONB
      WHEN jsonb_typeof(v_existing_notes) = 'array'
        THEN v_existing_notes
      WHEN jsonb_typeof(v_existing_notes) = 'object'
        THEN jsonb_build_array(v_existing_notes)
      WHEN jsonb_typeof(v_existing_notes) = 'string'
        THEN jsonb_build_array(jsonb_build_object(
          'kind', 'legacy_processing_note',
          'message', v_existing_notes #>> '{}'
        ))
      ELSE jsonb_build_array(jsonb_build_object(
        'kind', 'legacy_processing_note',
        'value', v_existing_notes
      ))
    END;

    -- Current clients pass the prior display value plus the new conflict text.
    -- Keep only the final line as the new structured message; prior diagnostics
    -- are preserved above in their original structured form.
    v_note_message := reverse(split_part(
      reverse(COALESCE(
        NULLIF(p_processing_notes, ''),
        p_next_state->>'detail',
        'Monthly-card membership conflict'
      )),
      E'\n',
      1
    ));
    v_next_notes := v_next_notes || jsonb_build_array(jsonb_strip_nulls(
      jsonb_build_object(
        'kind', 'monthly_card_membership_conflict',
        'message', v_note_message,
        'code', p_next_state->>'code',
        'member_id', p_next_state->>'member_id',
        'recorded_at', COALESCE(
          p_next_state->>'detected_at',
          pg_catalog.clock_timestamp()::TEXT
        )
      )
    ));
  END IF;

  UPDATE public.form_submission AS submission
     SET payment_meta = CASE
       WHEN p_remove_state
         THEN COALESCE(submission.payment_meta, '{}'::JSONB) - 'monthly_card_state'
       ELSE jsonb_set(
         COALESCE(submission.payment_meta, '{}'::JSONB),
         '{monthly_card_state}',
         p_next_state,
         TRUE
       )
     END,
     processing_notes = CASE
       WHEN p_write_processing_notes THEN v_next_notes
       ELSE submission.processing_notes
     END
   WHERE submission.id = p_submission_id
     AND submission.payment_meta = p_expected_payment_meta
     AND (
       p_expected_payment_status IS NULL
       OR submission.payment_status = p_expected_payment_status
     )
     AND (
       NOT p_expect_state_absent
       OR submission.payment_meta->'monthly_card_state' IS NULL
     )
     AND (
       p_expected_state_status IS NULL
       OR submission.payment_meta->'monthly_card_state'->>'status'
            = p_expected_state_status
     )
     AND (
       p_expected_claimed_at IS NULL
       OR submission.payment_meta->'monthly_card_state'->>'claimed_at'
            = p_expected_claimed_at
     )
     AND (
       p_expected_owner_token IS NULL
       OR submission.payment_meta->'monthly_card_state'->>'owner_token'
            = p_expected_owner_token
     );

  RETURN FOUND;
END;
$$;

REVOKE ALL ON FUNCTION public.cas_form_monthly_card_state(
  UUID, JSONB, JSONB, BOOLEAN, TEXT, TEXT, BOOLEAN, TEXT, TEXT, TEXT, BOOLEAN
) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.cas_form_monthly_card_state(
  UUID, JSONB, JSONB, BOOLEAN, TEXT, TEXT, BOOLEAN, TEXT, TEXT, TEXT, BOOLEAN
) FROM anon;
REVOKE ALL ON FUNCTION public.cas_form_monthly_card_state(
  UUID, JSONB, JSONB, BOOLEAN, TEXT, TEXT, BOOLEAN, TEXT, TEXT, TEXT, BOOLEAN
) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.cas_form_monthly_card_state(
  UUID, JSONB, JSONB, BOOLEAN, TEXT, TEXT, BOOLEAN, TEXT, TEXT, TEXT, BOOLEAN
) TO service_role;