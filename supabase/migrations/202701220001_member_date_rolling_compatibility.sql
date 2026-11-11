BEGIN;
-- Preserve every existing rolling/fixed-term condition. Add only the separate
-- no-charge member-date shape, also enforced by member_date_history_guard.
DO $$
DECLARE existing text; definition text; needle text;
BEGIN
  SELECT pg_get_constraintdef(oid) INTO STRICT existing FROM pg_constraint
    WHERE conrelid='public.member_membership_history'::regclass
      AND conname='member_membership_history_rolling_complete_check';
  IF position('term_source_snapshot' in existing)=0 THEN
    IF left(existing,7)<>'CHECK (' OR right(existing,1)<>')' THEN
      RAISE EXCEPTION 'Unexpected membership commitment constraint';
    END IF;
    ALTER TABLE public.member_membership_history DROP CONSTRAINT member_membership_history_rolling_complete_check;
    EXECUTE 'ALTER TABLE public.member_membership_history ADD CONSTRAINT member_membership_history_rolling_complete_check CHECK ('
      || substring(existing from 8 for length(existing)-8) || ' OR coalesce((
        term_source_snapshot->>''type''=''member_date_field''
        AND term_key IS NULL AND commitment_snapshot IS NULL AND previous_term_id IS NULL
        AND term_anchor_date IS NULL AND term_duration_months IS NULL AND billing_agreement_id IS NULL
        AND term_start_date IS NOT NULL AND term_end_date IS NOT NULL
        AND term_end_date>=term_start_date AND membership_renewal_date IS NOT NULL
        AND membership_renewal_date=term_end_date+1
        AND annual_cost=0 AND final_cost=0 AND total_with_vat=0 AND coalesce(vat_amount,0)=0
      ),false))';
  END IF;
  definition := pg_get_functiondef('public.enforce_rolling_membership_commitment()'::regprocedure);
  needle := 'IF TG_OP = ''INSERT'' AND NOT is_agreement AND EXISTS (';
  IF position('-- member_date_rolling_compatibility_v1' in definition)=0 THEN
    IF (length(definition)-length(replace(definition,needle,'')))/length(needle)<>1 THEN
      RAISE EXCEPTION 'Unexpected rolling commitment insertion guard';
    END IF;
    -- Do not return early: owner fences, date guards and all UPDATE protections
    -- remain active. Only exempt verified member-date INSERTs from requiring a
    -- fixed-month commitment.
    definition := replace(definition,needle,
      '-- member_date_rolling_compatibility_v1
    IF TG_OP = ''INSERT'' AND NOT is_agreement
      AND NOT (TG_TABLE_NAME=''member_membership_history''
        AND coalesce(r#>>''{term_source_snapshot,type}'','''')=''member_date_field''
        AND EXISTS(SELECT 1 FROM public.membership_tier_config md
          WHERE md.id=(r->>''config_id'')::uuid AND md.tenant_id=(r->>''tenant_id'')::uuid
            AND md.term_end_mode=''member_date_field''))
      AND EXISTS (');
    EXECUTE definition;
  END IF;
  definition := pg_get_functiondef('public.guard_member_date_history()'::regprocedure);
  IF position('-- member_date_saved_renewal_policy_v1' in definition)=0 THEN
    needle := 'IF TG_OP=''INSERT'' OR OLD.term_source_snapshot IS NULL THEN';
    IF (length(definition)-length(replace(definition,needle,'')))/length(needle)<>1 THEN
      RAISE EXCEPTION 'Unexpected member date-term evidence guard';
    END IF;
    definition := replace(definition,needle,needle || '
    -- member_date_saved_renewal_policy_v1
    NEW.renewal_policy_snapshot := to_jsonb(cfg);
    -- A no-charge form completion has no external payment rail. Keep it
    -- compatible with the non-recurring manual-membership display.
    IF NEW.payment_method IS NULL THEN NEW.payment_method := ''manual''; END IF;');
    needle := 'IF TG_OP=''UPDATE'' AND OLD.term_source_snapshot IS NOT NULL THEN';
    IF (length(definition)-length(replace(definition,needle,'')))/length(needle)<>1 THEN
      RAISE EXCEPTION 'Unexpected member date-term immutability guard';
    END IF;
    definition := replace(definition,needle,needle || '
    IF NEW.renewal_policy_snapshot IS DISTINCT FROM OLD.renewal_policy_snapshot THEN
      RAISE EXCEPTION ''Member date-term renewal policy is immutable'';
    END IF;');
    EXECUTE definition;
  END IF;
END $$;
-- Existing history uses column-level UPDATE grants; adding a column does not
-- inherit them. The date-term trigger enforces immutable evidence thereafter.
GRANT UPDATE(term_source_snapshot) ON public.member_membership_history TO service_role;
COMMIT;
