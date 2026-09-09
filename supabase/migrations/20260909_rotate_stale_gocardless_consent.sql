CREATE OR REPLACE FUNCTION public.rotate_stale_gocardless_consent(
  p_source_agreement_id uuid,
  p_replacement_idempotency_key text,
  p_replacement_metadata jsonb
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  source_row public.membership_billing_agreements%ROWTYPE;
  replacement_row public.membership_billing_agreements%ROWTYPE;
BEGIN
  SELECT * INTO source_row
  FROM public.membership_billing_agreements
  WHERE id = p_source_agreement_id
  FOR UPDATE;

  IF source_row.id IS NULL THEN
    RAISE EXCEPTION 'source billing agreement not found';
  END IF;

  IF source_row.idempotency_key = p_replacement_idempotency_key THEN
    RAISE EXCEPTION 'replacement consent generation is already current';
  END IF;

  IF p_replacement_metadata #>> '{dd,kind}' IS DISTINCT FROM 'monthly_direct_debit'
    OR p_replacement_metadata #>> '{dd,billing_request_mode}' IS DISTINCT FROM 'mandate_only'
    OR jsonb_typeof(p_replacement_metadata #> '{dd,monthly_amount_minor}') IS DISTINCT FROM 'number'
    OR (p_replacement_metadata #>> '{dd,monthly_amount_minor}')::numeric <= 0
    OR jsonb_typeof(p_replacement_metadata #> '{dd,instalment_count}') IS DISTINCT FROM 'number'
    OR (p_replacement_metadata #>> '{dd,instalment_count}')::numeric <= 0
    OR p_replacement_metadata #> '{dd,billing_request_payment}' IS NOT NULL
  THEN
    RAISE EXCEPTION 'replacement consent snapshot is incomplete';
  END IF;

  SELECT * INTO replacement_row
  FROM public.membership_billing_agreements
  WHERE idempotency_key = p_replacement_idempotency_key;
  IF replacement_row.id IS NOT NULL THEN
    RETURN to_jsonb(replacement_row);
  END IF;

  IF source_row.provider IS DISTINCT FROM 'gocardless'
    OR source_row.status IS DISTINCT FROM 'payment_setup_required'
    OR source_row.gocardless_mandate_id IS NOT NULL
    OR source_row.metadata #>> '{gocardless_initial_payment,id}' IS NOT NULL
    OR EXISTS (
      SELECT 1 FROM public.membership_payment_plans p
      WHERE p.billing_agreement_id = source_row.id
    )
  THEN
    RAISE EXCEPTION 'billing agreement is no longer safe to replace';
  END IF;

  INSERT INTO public.membership_billing_agreements (
    tenant_id, member_id, organization_id, agreement_type, status,
    idempotency_key, environment, metadata, provider,
    primary_contact_member_id, billing_contact_name, billing_contact_email,
    dd_payer, mandate_completed_by
  ) VALUES (
    source_row.tenant_id, source_row.member_id, source_row.organization_id,
    source_row.agreement_type, 'payment_setup_required',
    p_replacement_idempotency_key, source_row.environment,
    p_replacement_metadata, 'gocardless',
    source_row.primary_contact_member_id, source_row.billing_contact_name,
    source_row.billing_contact_email, source_row.dd_payer,
    source_row.mandate_completed_by
  )
  RETURNING * INTO replacement_row;

  UPDATE public.member_membership_history
  SET billing_agreement_id = replacement_row.id
  WHERE billing_agreement_id = source_row.id;

  UPDATE public.organisation_membership_history
  SET billing_agreement_id = replacement_row.id
  WHERE billing_agreement_id = source_row.id;

  UPDATE public.membership_dd_invitations
  SET billing_agreement_id = replacement_row.id, updated_at = now()
  WHERE billing_agreement_id = source_row.id AND status = 'pending';

  UPDATE public.membership_billing_agreements
  SET status = 'payment_plan_cancelled',
      metadata = jsonb_set(
        COALESCE(metadata, '{}'::jsonb),
        '{consent_superseded_by}',
        to_jsonb(replacement_row.id::text),
        true
      ),
      updated_at = now()
  WHERE id = source_row.id;

  RETURN to_jsonb(replacement_row);
END;
$$;

REVOKE ALL ON FUNCTION public.rotate_stale_gocardless_consent(uuid, text, jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rotate_stale_gocardless_consent(uuid, text, jsonb)
  TO service_role;