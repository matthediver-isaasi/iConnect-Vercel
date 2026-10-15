-- One operator-approved data correction, applied by the paired provider-verifying
-- runner in a transaction. Only ordinary lifecycle changes are subsequently
-- allowed on this exact paid upfront record; all other alpha guards remain.
-- No reusable financial bypass, new grant or disabled trigger remains.
DO $repair$
DECLARE
  original text;
  patched text;
  final_guard text;
  rolling_original text;
  one_off_gate text;
  expected_old jsonb;
  expected_new jsonb;
  actual jsonb;
  assignments text;
BEGIN
  IF to_regclass('pg_temp.approved_paypal_correction') IS NULL THEN
    RAISE EXCEPTION 'Run only through the provider-verifying correction runner';
  END IF;
  SELECT old_row,new_row INTO STRICT expected_old,expected_new FROM pg_temp.approved_paypal_correction;
  IF expected_old->>'id' <> '8a93eadf-7ff6-58c8-a7bc-ab9300af3d4c'
    OR expected_new->>'id' <> expected_old->>'id'
    OR expected_new->>'member_id' <> 'fd961c88-01ed-4be9-9e2f-158c57c5766f'
    OR expected_new->>'tenant_id' <> 'ff2df806-b321-4254-b651-3af11fccf1db'
    OR expected_new->>'payment_method' <> 'upfront'
    OR expected_new->>'payment_status' <> 'paid'
    OR expected_new->>'term_start_date' <> '2026-04-02'
    OR expected_new->>'term_end_date' <> '2027-04-01'
    OR expected_new->>'accounting_invoice_id' <> '18c13fa0-6f41-40a6-b3e6-f39be1ccbbbc'
    OR (expected_new->>'total_with_vat')::numeric <> 156 THEN
    RAISE EXCEPTION 'Unapproved correction';
  END IF;
  SELECT pg_get_functiondef('public.bnms_dd_alpha_canonical_guard()'::regprocedure) INTO original;
  IF position('Released alpha membership financial/dated terms are immutable' IN original)=0 THEN
    RAISE EXCEPTION 'Unexpected alpha guard';
  END IF;
  one_off_gate := '  IF TG_TABLE_NAME=''member_membership_history'' AND TG_OP=''UPDATE'' THEN'
    || ' IF OLD.id=''8a93eadf-7ff6-58c8-a7bc-ab9300af3d4c''::uuid'
    || ' AND EXISTS (SELECT 1 FROM pg_temp.approved_paypal_correction correction'
    || ' WHERE correction.old_row=to_jsonb(OLD) AND correction.new_row=to_jsonb(NEW)) THEN RETURN NEW; END IF; END IF;' || E'\n';
  patched := replace(original, E'BEGIN\n', E'BEGIN\n' || one_off_gate);
  IF patched=original THEN RAISE EXCEPTION 'Guard patch did not match'; END IF;
  EXECUTE patched;
  SELECT pg_get_functiondef('public.enforce_rolling_membership_commitment()'::regprocedure) INTO rolling_original;
  patched := replace(rolling_original, E'BEGIN\n', E'BEGIN\n' || one_off_gate);
  IF patched=rolling_original THEN RAISE EXCEPTION 'Rolling guard patch did not match'; END IF;
  EXECUTE patched;
  SELECT string_agg(format('%I=n.%I',key,key),',') INTO assignments
    FROM jsonb_object_keys(expected_new) key WHERE key<>'id';
  EXECUTE 'UPDATE public.member_membership_history h SET ' || assignments ||
    ' FROM jsonb_populate_record(NULL::public.member_membership_history,$1) n'
    || ' WHERE h.id=n.id AND h.tenant_id=n.tenant_id' USING expected_new;
  EXECUTE rolling_original;
  IF pg_get_functiondef('public.enforce_rolling_membership_commitment()'::regprocedure) <> rolling_original THEN
    RAISE EXCEPTION 'Rolling guard was not restored';
  END IF;
  -- A paid PayPal record cannot satisfy the GC-first-payment activation rule.
  -- Keep its financial terms immutable but allow normal expiry/renewal bookkeeping.
  final_guard := replace(original, E'BEGIN\n', E'BEGIN\n'
    || '  IF TG_TABLE_NAME=''member_membership_history'' AND TG_OP=''UPDATE'' THEN'
    || ' IF OLD.id=''8a93eadf-7ff6-58c8-a7bc-ab9300af3d4c''::uuid'
    || ' AND OLD.tenant_id=''ff2df806-b321-4254-b651-3af11fccf1db''::uuid'
    || ' AND OLD.member_id=''fd961c88-01ed-4be9-9e2f-158c57c5766f''::uuid'
    || ' AND OLD.payment_method=''upfront'' AND OLD.payment_status=''paid'''
    || ' AND OLD.accounting_invoice_id=''18c13fa0-6f41-40a6-b3e6-f39be1ccbbbc'''
    || ' AND (to_jsonb(NEW)-ARRAY[''status'',''updated_at'',''expiry_enforced_at'',''expiry_enforcement_key'','
    || '''annual_renewal_state'',''annual_renewal_processed_at'',''annual_renewal_idempotency_key''])'
    || ' = (to_jsonb(OLD)-ARRAY[''status'',''updated_at'',''expiry_enforced_at'',''expiry_enforcement_key'','
    || '''annual_renewal_state'',''annual_renewal_processed_at'',''annual_renewal_idempotency_key''])'
    || ' THEN RETURN NEW; END IF; END IF;' || E'\n');
  EXECUTE final_guard;
  IF pg_get_functiondef('public.bnms_dd_alpha_canonical_guard()'::regprocedure) <> final_guard THEN
    RAISE EXCEPTION 'Final guard was not installed';
  END IF;
  SELECT to_jsonb(h) INTO actual FROM public.member_membership_history h
    WHERE id='8a93eadf-7ff6-58c8-a7bc-ab9300af3d4c';
  IF actual IS DISTINCT FROM expected_new THEN RAISE EXCEPTION 'Correction verification failed'; END IF;
END $repair$;
