-- Keep the full payment_meta CAS in the POST body. Large paid-form metadata
-- must never be encoded into PostgREST's update-query URL.
CREATE OR REPLACE FUNCTION public.claim_form_payment_finalization(
  p_tenant_id UUID,
  p_submission_id UUID,
  p_expected_payment_meta JSONB,
  p_claimed_at TIMESTAMPTZ,
  p_owner_token UUID DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_next_meta JSONB;
  v_row public.form_submission%ROWTYPE;
  v_completion JSONB;
BEGIN
  IF p_tenant_id IS NULL
     OR p_submission_id IS NULL
     OR p_expected_payment_meta IS NULL
     OR jsonb_typeof(p_expected_payment_meta) <> 'object'
     OR p_claimed_at IS NULL THEN
    RAISE EXCEPTION 'invalid form payment finalization claim arguments'
      USING ERRCODE = '22023';
  END IF;

  IF p_owner_token IS NULL THEN
    -- Legacy initial claim: completion receipts are owned by the fenced path,
    -- and an existing finalized key (including JSON null) is not claimable.
    IF p_expected_payment_meta ? 'completion'
       OR p_expected_payment_meta ? 'finalized' THEN
      RAISE EXCEPTION 'invalid legacy form payment finalization snapshot'
        USING ERRCODE = '22023';
    END IF;
    v_next_meta := p_expected_payment_meta
      || jsonb_build_object('finalized', TRUE, 'finalized_at', p_claimed_at);
  ELSE
    v_completion := p_expected_payment_meta->'completion';
    IF jsonb_typeof(v_completion) IS DISTINCT FROM 'object'
       OR v_completion->>'version' IS DISTINCT FROM '1'
       OR v_completion->>'status' IS NULL
       OR v_completion->>'status' IN ('done', 'attention') THEN
      RAISE EXCEPTION 'invalid completion form payment finalization snapshot'
        USING ERRCODE = '22023';
    END IF;
    v_next_meta := jsonb_set(
      p_expected_payment_meta
        || jsonb_build_object(
          'finalized', TRUE,
          'finalized_at', CASE
            WHEN NULLIF(p_expected_payment_meta->>'finalized_at', '') IS NOT NULL
              THEN p_expected_payment_meta->'finalized_at'
            ELSE to_jsonb(p_claimed_at)
          END
        ),
      '{completion}',
      v_completion || jsonb_build_object(
        'status', 'processing',
        'claimed_at', p_claimed_at,
        'owner_token', p_owner_token,
        'attempts', COALESCE((v_completion->>'attempts')::INTEGER, 0) + 1
      )
    );
  END IF;

  UPDATE public.form_submission AS submission
     SET payment_meta = v_next_meta
   WHERE submission.id = p_submission_id
     AND submission.tenant_id = p_tenant_id
     AND submission.payment_status = 'paid'
     AND submission.payment_meta = p_expected_payment_meta
  RETURNING submission.* INTO v_row;

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  RETURN to_jsonb(v_row);
END;
$$;

REVOKE ALL ON FUNCTION public.claim_form_payment_finalization(
  UUID, UUID, JSONB, TIMESTAMPTZ, UUID
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_form_payment_finalization(
  UUID, UUID, JSONB, TIMESTAMPTZ, UUID
) TO service_role;