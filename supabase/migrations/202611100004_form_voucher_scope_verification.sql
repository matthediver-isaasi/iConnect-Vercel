BEGIN;
-- Preserve the installed routing/financial contract. This additive guard does
-- not backfill legacy metadata or modify any checkout or financial rows.
DO $migration$
DECLARE
  definition text;
  anchor text := '  SELECT * INTO b FROM public.form_membership_voucher_checkout WHERE election_id=e.id AND released_at IS NULL;';
  replay_anchor text := '    RETURN to_jsonb(t);';
  scope_guard text := $guard$
  -- form_voucher_scope_verification_v1
  IF jsonb_typeof(p_breakdown#>'{formVoucher,formId}') IS DISTINCT FROM 'string'
    OR jsonb_typeof(p_breakdown#>'{formVoucher,paymentFieldId}') IS DISTINCT FROM 'string'
    OR coalesce(p_breakdown#>>'{formVoucher,formId}','')=''
    OR coalesce(p_breakdown#>>'{formVoucher,paymentFieldId}','')='' THEN
    RAISE EXCEPTION 'Verified renewal form and payment field are required';
  END IF;
  IF NOT EXISTS (
    SELECT FROM public.form f,
      LATERAL jsonb_array_elements(f.fields) field
    WHERE f.id::text=p_breakdown#>>'{formVoucher,formId}'
      AND f.tenant_id=p_tenant_id
      AND field->>'id'=p_breakdown#>>'{formVoucher,paymentFieldId}'
      AND field->>'type'='membership_payment'
  ) THEN RAISE EXCEPTION 'Renewal form and payment field are unavailable'; END IF;
$guard$;
  replay_guard text := $guard$
    IF t.tenant_id IS DISTINCT FROM p_tenant_id
      OR t.member_id IS DISTINCT FROM p_member_id OR t.organization_id IS NOT NULL
      OR t.cost_breakdown#>>'{formVoucher,electionId}' IS DISTINCT FROM e.id::text
      OR t.cost_breakdown#>>'{formVoucher,formId}' IS DISTINCT FROM p_breakdown#>>'{formVoucher,formId}'
      OR t.cost_breakdown#>>'{formVoucher,paymentFieldId}' IS DISTINCT FROM p_breakdown#>>'{formVoucher,paymentFieldId}' THEN
      RAISE EXCEPTION 'Original credit checkout scope requires verification; do not start another payment';
    END IF;
$guard$;
BEGIN
  definition := pg_get_functiondef('public.bind_form_membership_voucher_checkout(uuid,uuid,uuid,jsonb,text)'::regprocedure);
  IF position('form_voucher_scope_verification_v1' IN definition)>0 THEN RETURN; END IF;
  IF (length(definition)-length(replace(definition,anchor,'')))/length(anchor)<>1
    OR (length(definition)-length(replace(definition,replay_anchor,'')))/length(replay_anchor)<>1 THEN
    RAISE EXCEPTION 'Unexpected form voucher binding contract; scope guard not installed';
  END IF;
  definition := replace(definition,anchor,scope_guard||anchor);
  EXECUTE replace(definition,replay_anchor,replay_guard||replay_anchor);
END $migration$;
COMMIT;
