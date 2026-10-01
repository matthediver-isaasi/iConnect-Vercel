-- Attachment only; no historical DML, provider calls, consent or cadence changes.
-- Full reviewed body fingerprints fail closed on unreviewed function evolution.
-- Supports both original cadence and the existing schedule-amendment wrapper.
DO $migration$
DECLARE
  target regprocedure := to_regprocedure('public.attach_gocardless_dynamic_payment(uuid,uuid,jsonb)');
  inner_target regprocedure := to_regprocedure('public.attach_gocardless_dynamic_payment_before_schedule_amendments(uuid,uuid,jsonb)');
  current_body text; original_body text; patched_body text; definition text;
  old_lookup text := $old$  SELECT * INTO p FROM public.membership_payment_plans WHERE id=r.plan_id AND tenant_id=p_tenant_id;
  SELECT * INTO a FROM public.membership_billing_agreements WHERE id=r.billing_agreement_id AND tenant_id=p_tenant_id;
$old$;
  new_lookup text := $new$  -- Canonical environment comes only from tenant-owned, agreeing billing records.
  SELECT * INTO p FROM public.membership_payment_plans WHERE id=r.plan_id AND tenant_id=p_tenant_id FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Dynamic collection plan not found in tenant'; END IF;
  SELECT * INTO a FROM public.membership_billing_agreements WHERE id=r.billing_agreement_id AND tenant_id=p_tenant_id FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Dynamic collection agreement not found in tenant'; END IF;
  IF p.billing_agreement_id IS DISTINCT FROM a.id
    OR p.provider IS DISTINCT FROM 'gocardless' OR a.provider IS DISTINCT FROM 'gocardless'
    OR p.environment IS NULL OR p.environment NOT IN ('live','sandbox')
    OR a.environment IS DISTINCT FROM p.environment
    OR a.gocardless_mandate_id IS DISTINCT FROM p.gocardless_mandate_id
    OR (p_payment ? 'environment' AND p_payment->>'environment' IS DISTINCT FROM p.environment) THEN
    RAISE EXCEPTION 'Dynamic collection billing ownership or environment mismatch';
  END IF;
$new$;
  old_insert text := $old$INSERT INTO public.gocardless_payments(tenant_id,plan_id,gocardless_payment_id,gocardless_mandate_id,amount_minor,currency,charge_date,status,updated_at)
    VALUES(p_tenant_id,p.id,p_payment->>'id',p.gocardless_mandate_id,r.amount_minor,r.currency,r.requested_charge_date,p_payment->>'status',now())$old$;
  new_insert text := $new$INSERT INTO public.gocardless_payments(tenant_id,plan_id,gocardless_payment_id,gocardless_mandate_id,amount_minor,currency,charge_date,status,updated_at,environment)
    VALUES(p_tenant_id,p.id,p_payment->>'id',p.gocardless_mandate_id,r.amount_minor,r.currency,r.requested_charge_date,p_payment->>'status',now(),p.environment)$new$;
  old_conflict text := $old$OR amount_minor IS DISTINCT FROM r.amount_minor OR currency IS DISTINCT FROM r.currency))$old$;
  new_conflict text := $new$OR amount_minor IS DISTINCT FROM r.amount_minor OR currency IS DISTINCT FROM r.currency
      OR gocardless_mandate_id IS DISTINCT FROM p.gocardless_mandate_id
      OR charge_date IS DISTINCT FROM r.requested_charge_date
      OR environment IS DISTINCT FROM p.environment))$new$;
BEGIN
  IF target IS NULL THEN RAISE EXCEPTION 'Attachment contract missing'; END IF;
  IF inner_target IS NOT NULL THEN
    IF (SELECT md5(prosrc) FROM pg_proc WHERE oid=target) <> '3da2858c7a16a585dd5bb566a5777c1a'
      OR to_regprocedure('public.gocardless_dynamic_collection_due_date(uuid,integer)') IS NULL THEN
      RAISE EXCEPTION 'Unreviewed attachment wrapper contract';
    END IF;
    target := inner_target;
  ELSIF to_regprocedure('public.gocardless_dynamic_collection_due_date(uuid,integer)') IS NOT NULL THEN
    RAISE EXCEPTION 'Partial amended attachment contract';
  END IF;
  SELECT prosrc,pg_get_functiondef(oid) INTO current_body,definition FROM pg_proc WHERE oid=target;
  original_body := replace(replace(replace(current_body,new_lookup,old_lookup),new_insert,old_insert),new_conflict,old_conflict);
  IF md5(original_body) IS DISTINCT FROM
    (CASE WHEN inner_target IS NULL THEN '12d2f37b4ad180c10bb16fdac99c3d22' ELSE 'f74435cbb0630e43281348a3efb4b80e' END) THEN
    RAISE EXCEPTION 'Unreviewed attachment implementation; no changes applied';
  END IF;
  patched_body := replace(replace(replace(original_body,old_lookup,new_lookup),old_insert,new_insert),old_conflict,new_conflict);
  IF current_body <> original_body AND current_body <> patched_body THEN
    RAISE EXCEPTION 'Partial environment patch; no changes applied';
  END IF;
  IF current_body <> patched_body THEN
    -- CREATE OR REPLACE preserves existing ACL/owner and original signature,
    -- SECURITY DEFINER/search_path; the wrapper and every other routine stay intact.
    EXECUTE replace(definition,current_body,patched_body);
  END IF;
END
$migration$;