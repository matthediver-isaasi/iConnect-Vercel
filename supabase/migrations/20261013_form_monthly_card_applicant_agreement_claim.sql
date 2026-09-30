-- Serialize form monthly-card agreement ownership by applicant and membership
-- year. Existing legacy per-submission agreements are claimed before a new
-- canonical agreement can be inserted, so two live Stripe Checkouts cannot be
-- published for the same pre-member identity.

CREATE OR REPLACE FUNCTION claim_form_monthly_card_applicant_agreement(
  p_tenant_id UUID,
  p_submission_id UUID,
  p_applicant_email TEXT,
  p_membership_year TEXT,
  p_agreement_key TEXT,
  p_environment TEXT,
  p_card_snapshot JSONB,
  p_member_id UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_submission form_submission%ROWTYPE;
  v_agreement membership_billing_agreements%ROWTYPE;
  v_identity TEXT;
  v_recovered_legacy BOOLEAN := false;
BEGIN
  IF p_tenant_id IS NULL
     OR p_submission_id IS NULL
     OR NULLIF(BTRIM(LOWER(p_applicant_email)), '') IS NULL
     OR NULLIF(BTRIM(p_membership_year), '') IS NULL
     OR p_agreement_key NOT LIKE 'form-card-applicant:%' THEN
    RETURN jsonb_build_object(
      'ok', false,
      'code', 'INVALID_APPLICANT_IDENTITY',
      'detail', 'Applicant agreement identity is incomplete'
    );
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(p_agreement_key, 0));
  v_identity := SUBSTRING(p_agreement_key FROM LENGTH('form-card-applicant:') + 1);

  -- Match expired-Checkout release's agreement-then-submission lock order.
  SELECT *
    INTO v_agreement
    FROM membership_billing_agreements
   WHERE idempotency_key = p_agreement_key
   FOR UPDATE;

  -- Legacy agreements used form-card:<submission UUID>. Match through their
  -- pending submission because those rows predate applicant_identity metadata.
  IF NOT FOUND THEN
    SELECT agreement.*
      INTO v_agreement
      FROM membership_billing_agreements agreement
      JOIN form_submission submission
        ON agreement.metadata->>'form_submission_id' = submission.id::TEXT
     WHERE agreement.tenant_id = p_tenant_id
       AND agreement.provider = 'stripe'
       AND agreement.agreement_type = 'member'
       AND agreement.status <> 'expired'
       AND agreement.idempotency_key = 'form-card:' || submission.id::TEXT
       AND submission.tenant_id = p_tenant_id
       AND submission.payment_status = 'pending'
       AND submission.payment_provider = 'stripe_monthly_card'
       AND BTRIM(LOWER(COALESCE(
         submission.payment_meta->'monthly_card'->>'applicant_email',
         submission.submitted_by_email,
         ''
       ))) = BTRIM(LOWER(p_applicant_email))
       AND COALESCE(
         agreement.metadata->'card'->>'membership_year',
         submission.payment_meta->'membership'->'quote'->>'membership_year',
         ''
       ) = p_membership_year
     ORDER BY (agreement.stripe_checkout_session_id IS NOT NULL) DESC,
              agreement.created_at ASC
     LIMIT 1
     FOR UPDATE OF agreement;
    v_recovered_legacy := FOUND;
  END IF;

  SELECT *
    INTO v_submission
    FROM form_submission
   WHERE id = p_submission_id
     AND tenant_id = p_tenant_id
   FOR UPDATE;

  IF NOT FOUND
     OR v_submission.payment_status <> 'pending'
     OR v_submission.payment_provider <> 'stripe_monthly_card'
     OR BTRIM(LOWER(COALESCE(
       v_submission.payment_meta->'monthly_card'->>'applicant_email',
       v_submission.submitted_by_email,
       ''
     ))) <> BTRIM(LOWER(p_applicant_email))
     OR COALESCE(
       v_submission.payment_meta->'membership'->'quote'->>'membership_year',
       ''
     ) <> p_membership_year THEN
    RETURN jsonb_build_object(
      'ok', false,
      'code', 'INVALID_FORM_SUBMISSION',
      'detail', 'The pending form submission does not match this applicant and membership year'
    );
  END IF;

  IF v_agreement.id IS NOT NULL AND NOT v_recovered_legacy THEN
    RETURN jsonb_build_object('ok', true, 'agreement', to_jsonb(v_agreement));
  END IF;

  IF v_recovered_legacy THEN
    UPDATE membership_billing_agreements
       SET idempotency_key = p_agreement_key,
           metadata = COALESCE(metadata, '{}'::JSONB)
             || jsonb_build_object('applicant_identity', v_identity),
           updated_at = NOW()
     WHERE id = v_agreement.id
     RETURNING * INTO v_agreement;
    RETURN jsonb_build_object(
      'ok', true,
      'recovered_legacy', true,
      'agreement', to_jsonb(v_agreement)
    );
  END IF;

  INSERT INTO membership_billing_agreements (
    tenant_id,
    agreement_type,
    provider,
    member_id,
    status,
    idempotency_key,
    environment,
    metadata
  ) VALUES (
    p_tenant_id,
    'member',
    'stripe',
    p_member_id,
    'payment_setup_required',
    p_agreement_key,
    p_environment,
    jsonb_build_object(
      'card', COALESCE(p_card_snapshot, '{}'::JSONB),
      'form_submission_id', p_submission_id,
      'applicant_identity', v_identity
    )
  )
  RETURNING * INTO v_agreement;

  RETURN jsonb_build_object('ok', true, 'agreement', to_jsonb(v_agreement));
END;
$$;

REVOKE ALL ON FUNCTION claim_form_monthly_card_applicant_agreement(
  UUID, UUID, TEXT, TEXT, TEXT, TEXT, JSONB, UUID
) FROM PUBLIC;
REVOKE ALL ON FUNCTION claim_form_monthly_card_applicant_agreement(
  UUID, UUID, TEXT, TEXT, TEXT, TEXT, JSONB, UUID
) FROM anon;
REVOKE ALL ON FUNCTION claim_form_monthly_card_applicant_agreement(
  UUID, UUID, TEXT, TEXT, TEXT, TEXT, JSONB, UUID
) FROM authenticated;
GRANT EXECUTE ON FUNCTION claim_form_monthly_card_applicant_agreement(
  UUID, UUID, TEXT, TEXT, TEXT, TEXT, JSONB, UUID
) TO service_role;