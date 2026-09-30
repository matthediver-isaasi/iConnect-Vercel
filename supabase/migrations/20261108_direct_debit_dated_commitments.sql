-- Extend the existing guarded commitment implementation, retaining its full
-- owner, predecessor, overlap, retry and immutable price checks. No data rewrite.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['member_membership_history','organisation_membership_history','membership_billing_agreements'] LOOP
    EXECUTE format('ALTER TABLE public.%I DROP CONSTRAINT IF EXISTS %I',t,t||'_rolling_complete_check');
    EXECUTE format('ALTER TABLE public.%I ADD CONSTRAINT %I CHECK (
      (term_key IS NULL AND membership_renewal_date IS NULL AND term_duration_months IS NULL
        AND term_anchor_date IS NULL AND commitment_snapshot IS NULL AND previous_term_id IS NULL)
      OR (term_key IS NOT NULL AND term_start_date IS NOT NULL AND term_end_date IS NOT NULL
        AND membership_renewal_date IS NOT NULL AND term_duration_months IN (1,3,12)
        AND term_duration_months IS NOT NULL AND term_anchor_date IS NOT NULL
        AND term_anchor_date <= term_start_date AND term_start_date <= term_end_date
        AND term_end_date + 1 = membership_renewal_date
        AND commitment_snapshot IS NOT NULL AND jsonb_typeof(commitment_snapshot) = ''object''
        AND ((term_key = ''rolling:'' || to_char(term_start_date,''YYYY-MM-DD'')
          AND commitment_snapshot->>''start_mode'' = ''immediate'')
          OR (term_key = ''fixed:'' || to_char(term_start_date,''YYYY-MM-DD'')
            AND commitment_snapshot->>''start_mode'' = ''fixed_date''
            AND commitment_snapshot->>''payment_method'' = ''direct_debit''))))',t,t||'_rolling_complete_check');
  END LOOP;
END $$;

DO $migration$
DECLARE definition text; original text; changed text;
BEGIN
  SELECT pg_get_functiondef('public.enforce_rolling_membership_commitment()'::regprocedure) INTO definition;
  IF strpos(definition,'explicit_dd_dated_commitments_v1') > 0 THEN RETURN; END IF;
  original := $old$OR c#>>'{commitment_snapshot,config,start_mode}' IS DISTINCT FROM 'immediate'
    OR c#>>'{commitment_snapshot,start_mode}' IS DISTINCT FROM 'immediate'$old$;
  changed := $new$OR NOT COALESCE((
      (c#>>'{commitment_snapshot,config,start_mode}' = 'immediate'
        AND c#>>'{commitment_snapshot,start_mode}' = 'immediate')
      OR (c#>>'{commitment_snapshot,config,start_mode}' = 'fixed_date'
        AND c#>>'{commitment_snapshot,start_mode}' = 'fixed_date'
        AND c#>>'{commitment_snapshot,payment_method}' = 'direct_debit'
        AND (c->>'term_key') = 'fixed:' || (c->>'term_start_date'))), false)
    -- explicit_dd_dated_commitments_v1$new$;
  IF strpos(definition,original)=0 THEN RAISE EXCEPTION 'Commitment configuration guard drift; review migration'; END IF;
  definition := replace(definition,original,changed);
  original := $old$IF c#>>ARRAY['commitment_snapshot','amounts',price_key] IS NULL
      OR c#>>ARRAY['commitment_snapshot','amounts',price_key] !~ '^[0-9]+([.][0-9]+)?$'
      OR (c#>>ARRAY['commitment_snapshot','amounts',price_key])::numeric < 0 THEN
      RAISE EXCEPTION 'Missing or invalid committed amount %', price_key;
    END IF;$old$;
  changed := $new$IF c#>>'{commitment_snapshot,payment_method}' = 'direct_debit'
      AND c#>>'{commitment_snapshot,collection_policy,version}' = '1'
      AND c#>>'{commitment_snapshot,collection_policy,pricing_policy}' = 'dynamic'
      AND c#>>'{commitment_snapshot,collection_policy,end_policy}' IN ('stop','continue')
      AND price_key IN ('final_cost','vat_amount','total_with_vat') THEN
      IF c#>>ARRAY['commitment_snapshot','amounts',price_key] IS NOT NULL THEN
        RAISE EXCEPTION 'Dynamic term totals must remain unknown, not fabricated';
      END IF;
      IF is_agreement AND (r#>>'{metadata,dd,collection_policy}' IS DISTINCT FROM
        c#>>'{commitment_snapshot,collection_policy}' OR r#>>'{metadata,dd,invoicing_mode}' IS DISTINCT FROM 'per_instalment') THEN
        RAISE EXCEPTION 'Dynamic commitment policy must match explicit invoicing consent';
      END IF;
    ELSIF c#>>ARRAY['commitment_snapshot','amounts',price_key] IS NULL
      OR c#>>ARRAY['commitment_snapshot','amounts',price_key] !~ '^[0-9]+([.][0-9]+)?$'
      OR (c#>>ARRAY['commitment_snapshot','amounts',price_key])::numeric < 0 THEN
      RAISE EXCEPTION 'Missing or invalid committed amount %', price_key;
    END IF;$new$;
  IF strpos(definition,original)=0 THEN RAISE EXCEPTION 'Commitment amount guard drift; review migration'; END IF;
  definition := replace(definition,original,changed);
  original := $old$NEW := jsonb_populate_record(NEW, jsonb_build_object('membership_year', c->>'term_key'));$old$;
  changed := $new$IF c#>>'{commitment_snapshot,start_mode}' = 'immediate' THEN
      NEW := jsonb_populate_record(NEW, jsonb_build_object('membership_year', c->>'term_key'));
    ELSIF COALESCE(r->>'membership_year','') = ''
      OR (TG_OP = 'UPDATE' AND old_r->>'term_key' IS NOT NULL
        AND r->>'membership_year' IS DISTINCT FROM old_r->>'membership_year') THEN
      RAISE EXCEPTION 'Fixed-cycle membership year must be preserved';
    END IF;$new$;
  IF strpos(definition,original)=0 THEN RAISE EXCEPTION 'Commitment year guard drift; review migration'; END IF;
  definition := replace(definition,original,changed);
  EXECUTE definition;
END $migration$;

-- The form binding RPC must not manufacture VAT=0 or copy a gross plan total
-- into a net amount. Use the saved dated commitment, including its NULL totals.
DO $migration$
DECLARE definition text; original text; changed text;
BEGIN
  SELECT pg_get_functiondef('public.bind_form_monthly_direct_debit_membership(uuid,uuid,uuid,jsonb)'::regprocedure) INTO definition;
  IF strpos(definition,'explicit_dd_form_amounts_v1') > 0 THEN RETURN; END IF;
  original := $old$NULLIF(COALESCE(v_snapshot->>'plan_total',v_snapshot->>'final_cost'),'')::NUMERIC$old$;
  changed := $new$CASE WHEN v_snapshot->'commitment'->>'term_key' IS NOT NULL
      THEN (v_snapshot#>>'{commitment,commitment_snapshot,amounts,final_cost}')::NUMERIC
      ELSE NULLIF(COALESCE(v_snapshot->>'plan_total',v_snapshot->>'final_cost'),'')::NUMERIC END /* explicit_dd_form_amounts_v1 */$new$;
  IF strpos(definition,original)=0 THEN RAISE EXCEPTION 'Form net amount guard drift; review migration'; END IF;
  definition := replace(definition,original,changed);
  original := $old$COALESCE(NULLIF(v_snapshot->>'vat_amount','')::NUMERIC,0)$old$;
  changed := $new$CASE WHEN v_snapshot->'commitment'->>'term_key' IS NOT NULL
      THEN (v_snapshot#>>'{commitment,commitment_snapshot,amounts,vat_amount}')::NUMERIC
      ELSE COALESCE(NULLIF(v_snapshot->>'vat_amount','')::NUMERIC,0) END$new$;
  IF strpos(definition,original)=0 THEN RAISE EXCEPTION 'Form VAT amount guard drift; review migration'; END IF;
  definition := replace(definition,original,changed);
  original := $old$NULLIF(COALESCE(v_snapshot->>'plan_total',v_snapshot->>'total_with_vat'),'')::NUMERIC$old$;
  changed := $new$CASE WHEN v_snapshot->'commitment'->>'term_key' IS NOT NULL
      THEN (v_snapshot#>>'{commitment,commitment_snapshot,amounts,total_with_vat}')::NUMERIC
      ELSE NULLIF(COALESCE(v_snapshot->>'plan_total',v_snapshot->>'total_with_vat'),'')::NUMERIC END$new$;
  IF strpos(definition,original)=0 THEN RAISE EXCEPTION 'Form gross amount guard drift; review migration'; END IF;
  definition := replace(definition,original,changed);
  EXECUTE definition;
END $migration$;