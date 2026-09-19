-- Keep monthly-card finalizer CAS payloads out of PostgREST query strings.
-- Large form pipeline metadata can exceed proxy/request-line limits when used
-- in eq(payment_meta,...). This RPC receives expected JSONB in the POST body,
-- compares it exactly, and patches only monthly_card_state atomically.
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
       WHEN p_write_processing_notes THEN p_processing_notes
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