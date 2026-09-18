-- New completion owners may observe (never replay) a timed-out operation.
-- Historical attention receipts remain terminal. Apply before deploying code.
CREATE OR REPLACE FUNCTION public.observe_or_begin_form_paid_pipeline_operation(
  p_tenant_id UUID, p_submission_id UUID, p_operation_id UUID,
  p_operation_kind TEXT DEFAULT 'primary'
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_meta JSONB;
  v_wait JSONB;
  v_operation public.form_paid_pipeline_operation%ROWTYPE;
  v_result JSONB;
  v_checkpoints JSONB;
BEGIN
  SELECT payment_meta, jsonb_build_object(
    'created_member_id', created_member_id,
    'created_organization_id', created_organization_id,
    'organization_id', organization_id,
    'payment_meta', payment_meta)
    INTO v_meta, v_checkpoints FROM public.form_submission
   WHERE id = p_submission_id AND tenant_id = p_tenant_id AND payment_status = 'paid'
   FOR UPDATE;
  IF NOT FOUND OR v_meta->'completion'->>'status' IS DISTINCT FROM 'processing'
     OR v_meta->'completion'->>'owner_token' IS DISTINCT FROM p_operation_id::TEXT THEN
    RETURN jsonb_build_object('status', 'attention', 'reason', 'completion owner was lost');
  END IF;
  v_wait := v_meta->'completion'->'awaiting_pipeline';
  IF v_wait IS NOT NULL THEN
    SELECT * INTO v_operation FROM public.form_paid_pipeline_operation
     WHERE form_submission_id = p_submission_id AND tenant_id = p_tenant_id FOR UPDATE;
    IF NOT FOUND OR v_operation.operation_id::TEXT IS DISTINCT FROM v_wait->>'operation_id' THEN
      RETURN jsonb_build_object('status', 'attention', 'reason', 'awaited operation identity was lost');
    END IF;
    IF v_operation.status = 'done' THEN
      UPDATE public.form_submission SET payment_meta = payment_meta #- '{completion,awaiting_pipeline}'
       WHERE id = p_submission_id AND tenant_id = p_tenant_id;
      RETURN jsonb_build_object('status', 'done', 'checkpoints', v_checkpoints);
    END IF;
    IF v_operation.status = 'processing' AND NOW() < (v_wait->>'expires_at')::TIMESTAMPTZ THEN
      RETURN jsonb_build_object('status', 'waiting', 'reason', 'awaiting durable processor outcome');
    END IF;
    RETURN jsonb_build_object('status', 'attention', 'reason', 'processor outcome is ambiguous or observation expired');
  END IF;
  v_result := public.begin_form_paid_pipeline_operation(
    p_tenant_id, p_submission_id, p_operation_id, p_operation_kind);
  IF v_result->>'status' = 'claimed' THEN
    UPDATE public.form_submission SET payment_meta = jsonb_set(payment_meta,
      '{completion,awaiting_pipeline}', jsonb_build_object(
        'operation_id', p_operation_id, 'expires_at', NOW() + INTERVAL '10 minutes'))
     WHERE id = p_submission_id AND tenant_id = p_tenant_id;
  ELSIF v_result->>'status' = 'done' THEN
    v_result := v_result || jsonb_build_object('checkpoints', v_checkpoints);
  END IF;
  RETURN v_result;
END;
$$;
REVOKE ALL ON FUNCTION public.observe_or_begin_form_paid_pipeline_operation(UUID, UUID, UUID, TEXT)
 FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.observe_or_begin_form_paid_pipeline_operation(UUID, UUID, UUID, TEXT)
 TO service_role;