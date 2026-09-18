-- Diagnostic-only, no backfill or provider effects. Lookup failures are not
-- payment failures. Keep unrelated JSON and terminal notes under the row lock.
CREATE OR REPLACE FUNCTION public.record_form_gocardless_reconciliation(
  p_tenant_id UUID, p_submission_id UUID, p_diagnostic JSONB
) RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_row public.form_submission%ROWTYPE;
  v_notes JSONB;
BEGIN
  IF jsonb_typeof(p_diagnostic) IS DISTINCT FROM 'object'
     OR COALESCE(p_diagnostic->>'status', '') NOT IN ('blocked', 'retry', 'waiting') THEN
    RAISE EXCEPTION 'Invalid GoCardless reconciliation diagnostic';
  END IF;
  SELECT * INTO v_row FROM public.form_submission
    WHERE id = p_submission_id AND tenant_id = p_tenant_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Form submission not found'; END IF;
  IF v_row.payment_status IS DISTINCT FROM 'pending'
    OR v_row.payment_provider NOT IN ('gocardless', 'gocardless_monthly_dd') THEN RETURN FALSE; END IF;
  -- A concurrent stale observer cannot un-block a review decision.
  IF v_row.payment_meta->'gc_reconciliation'->>'status' = 'blocked' THEN RETURN FALSE; END IF;
  v_notes := v_row.processing_notes;
  IF p_diagnostic->>'status' = 'blocked' THEN
    v_notes := CASE WHEN jsonb_typeof(v_notes) = 'array' THEN v_notes
      WHEN v_notes IS NULL OR v_notes = 'null'::jsonb THEN '[]'::jsonb
      ELSE jsonb_build_array(v_notes) END;
    IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_notes) n
      WHERE n->>'kind' = 'gocardless_reconciliation_blocked') THEN
      v_notes := v_notes || jsonb_build_array(jsonb_build_object(
        'kind', 'gocardless_reconciliation_blocked',
        'at', clock_timestamp(),
        'message', 'Direct Debit lookup requires administrator review. Payment outcome is unknown; do not request another payment.',
        'reason', p_diagnostic->>'reason'));
    END IF;
  END IF;
  UPDATE public.form_submission
    SET payment_meta = jsonb_set(COALESCE(payment_meta, '{}'::jsonb),
          '{gc_reconciliation}', p_diagnostic, true),
        processing_notes = v_notes
    WHERE id = p_submission_id AND tenant_id = p_tenant_id;
  RETURN TRUE;
END;
$$;
REVOKE ALL ON FUNCTION public.record_form_gocardless_reconciliation(UUID,UUID,JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_form_gocardless_reconciliation(UUID,UUID,JSONB) TO service_role;