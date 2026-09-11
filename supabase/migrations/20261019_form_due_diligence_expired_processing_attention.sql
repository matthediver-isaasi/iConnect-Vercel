-- Task #4375 follow-up: an expired initialization lease means an action may
-- have reached an external provider without its completion being checkpointed.
-- Never reclaim it for replay. Reconciliation performs this bounded sweep to
-- make the work visible for manual review instead.

CREATE OR REPLACE FUNCTION public.mark_expired_paid_form_due_diligence_attention(
  p_limit INTEGER DEFAULT 20
) RETURNS TABLE(form_submission_id UUID, tenant_id UUID, last_error TEXT)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
BEGIN
  RETURN QUERY
  WITH expired AS (
    SELECT lifecycle.form_submission_id, lifecycle.tenant_id
      FROM public.form_due_diligence_initialization lifecycle
     WHERE lifecycle.paid_eligible
       AND lifecycle.state = 'processing'
       AND lifecycle.lease_expires_at IS NOT NULL
       AND lifecycle.lease_expires_at <= NOW()
     ORDER BY lifecycle.lease_expires_at, lifecycle.form_submission_id
     LIMIT LEAST(GREATEST(p_limit, 1), 100)
     FOR UPDATE SKIP LOCKED
  ), transitioned AS (
    UPDATE public.form_due_diligence_initialization lifecycle
       SET state = 'requires_attention',
           lease_token = NULL,
           lease_expires_at = NULL,
           last_error = LEFT(
             CONCAT_WS('; ', NULLIF(lifecycle.last_error, ''),
               'Initialization lease expired; external action completion is ambiguous and requires manual review'),
             2000
           ),
           updated_at = NOW()
      FROM expired
     WHERE lifecycle.form_submission_id = expired.form_submission_id
       AND lifecycle.tenant_id = expired.tenant_id
     RETURNING lifecycle.form_submission_id, lifecycle.tenant_id, lifecycle.last_error
  )
  SELECT transitioned.form_submission_id, transitioned.tenant_id, transitioned.last_error
    FROM transitioned;
END;
$$;

REVOKE ALL ON FUNCTION public.mark_expired_paid_form_due_diligence_attention(INTEGER)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mark_expired_paid_form_due_diligence_attention(INTEGER)
  TO service_role;