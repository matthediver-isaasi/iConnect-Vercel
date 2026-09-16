-- Fence completion outcomes by the worker lease token.  Financial membership
-- progress shares payment_meta, so an outcome must merge only the completion
-- key and must never let an expired worker overwrite a newer owner's state.
CREATE OR REPLACE FUNCTION public.finish_form_payment_completion(
  p_tenant_id UUID,
  p_submission_id UUID,
  p_owner_token UUID,
  p_status TEXT,
  p_stage TEXT DEFAULT NULL,
  p_error TEXT DEFAULT NULL
) RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_updated UUID;
  v_completion JSONB;
BEGIN
  IF p_status NOT IN ('retryable', 'done') THEN
    RAISE EXCEPTION 'invalid form completion status' USING ERRCODE = '22023';
  END IF;

  UPDATE public.form_submission submission_row
     SET payment_meta = jsonb_set(
       COALESCE(submission_row.payment_meta, '{}'::JSONB),
       '{completion}',
       (submission_row.payment_meta->'completion') || jsonb_strip_nulls(
         jsonb_build_object(
           'status', p_status,
           'stage', p_stage,
           'last_error', CASE WHEN p_status = 'done' THEN NULL ELSE LEFT(COALESCE(p_error, 'retry incomplete'), 300) END,
           'completed_at', CASE WHEN p_status = 'done' THEN NOW()::TEXT ELSE NULL END
         )
       ),
       true
     )
   WHERE submission_row.id = p_submission_id
     AND submission_row.tenant_id = p_tenant_id
     AND submission_row.payment_status = 'paid'
     AND submission_row.payment_meta->'completion'->>'status' = 'processing'
     AND submission_row.payment_meta->'completion'->>'owner_token' = p_owner_token::TEXT
  RETURNING submission_row.id INTO v_updated;
  RETURN v_updated IS NOT NULL;
END;
$$;
-- The provider billing address is evidence from the charged PaymentIntent,
-- not a mutable profile field.  The first successful capture wins forever.
CREATE OR REPLACE FUNCTION public.capture_form_stripe_billing_address_once(
  p_tenant_id UUID,
  p_submission_id UUID,
  p_address JSONB
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE v_meta JSONB;
BEGIN
  IF jsonb_typeof(p_address) <> 'object' THEN
    RAISE EXCEPTION 'Stripe billing address must be an object' USING ERRCODE = '22023';
  END IF;
  UPDATE public.form_submission
     SET payment_meta = jsonb_set(COALESCE(payment_meta, '{}'::JSONB), '{stripe_billing_address}', p_address, true)
   WHERE id = p_submission_id
     AND tenant_id = p_tenant_id
      AND (
        (payment_provider = 'stripe' AND payment_status = 'paid')
        OR (payment_provider = 'stripe_monthly_card' AND payment_status = 'setup_complete')
      )
     AND payment_meta->'stripe_billing_address' IS NULL
  RETURNING payment_meta INTO v_meta;
  IF FOUND THEN RETURN v_meta; END IF;

  SELECT payment_meta INTO v_meta
    FROM public.form_submission
   WHERE id = p_submission_id
     AND tenant_id = p_tenant_id
      AND (
        (payment_provider = 'stripe' AND payment_status = 'paid')
        OR (payment_provider = 'stripe_monthly_card' AND payment_status = 'setup_complete')
      )
     AND payment_meta->'stripe_billing_address' IS NOT NULL;
  RETURN v_meta;
END;
$$;

-- These functions are called only by trusted server workers.  In particular
-- the capture function returns payment-time address data and must never be a
-- browser-accessible SECURITY DEFINER endpoint.
REVOKE ALL ON FUNCTION public.finish_form_payment_completion(UUID, UUID, UUID, TEXT, TEXT, TEXT)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.capture_form_stripe_billing_address_once(UUID, UUID, JSONB)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.finish_form_payment_completion(UUID, UUID, UUID, TEXT, TEXT, TEXT)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.capture_form_stripe_billing_address_once(UUID, UUID, JSONB)
  TO service_role;