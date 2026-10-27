-- Carry already-paid service forward only when the full net, VAT and gross
-- obligation is unchanged. This never authorises a credit/refund or new charge.
BEGIN;
CREATE FUNCTION public.member_monthly_unchanged_price_carry(a jsonb,input jsonb)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,public AS $$
DECLARE original jsonb:=input->'purchase'->'commitment_snapshot'->'amounts';
 target jsonb:=a->'calculation'->'targetFullPrice'; total bigint; paid bigint;
BEGIN
 IF a->'monthlyExecution'->>'unchangedPriceCarry' IS DISTINCT FROM 'true'
  OR original IS NULL OR target IS NULL
  OR jsonb_typeof(a->'fundingEvidence'->'settledFunding') IS DISTINCT FROM 'array' THEN RETURN false; END IF;
 total:=(target->>'grossMinor')::bigint;
 paid:=(a->'calculation'->'finance'->'settled'->>'grossMinor')::bigint;
 IF total IS NULL OR paid IS NULL OR total<=paid OR paid<0
  OR (target->>'netMinor')::numeric IS DISTINCT FROM (original->>'final_cost')::numeric*100
  OR (target->>'vatMinor')::numeric IS DISTINCT FROM (original->>'vat_amount')::numeric*100
  OR total IS DISTINCT FROM (original->>'total_with_vat')::numeric*100
  OR (target->>'netMinor')::bigint+(target->>'vatMinor')::bigint<>total
  OR (a->'calculation'->>'futureObligationMinor')::bigint IS DISTINCT FROM total-paid
  OR (a->'monthlyExecution'->'providerTarget'->>'termTotalMinor')::bigint IS DISTINCT FROM total
  OR (a->'monthlyExecution'->'providerFunding'->>'settledGrossMinor')::bigint IS DISTINCT FROM paid
  OR (SELECT coalesce(sum((f->>'grossMinor')::bigint),0)
      FROM jsonb_array_elements(a->'fundingEvidence'->'settledFunding') f) IS DISTINCT FROM paid
  OR EXISTS(SELECT 1 FROM jsonb_array_elements(a->'fundingEvidence'->'settledFunding') f
    WHERE f->>'kind' IS DISTINCT FROM 'cash' OR f->>'ownerType' IS DISTINCT FROM 'member'
     OR f->>'ownerId' IS DISTINCT FROM input->'purchase'->>'member_id'
     OR f->>'state' IS DISTINCT FROM 'settled'
     OR f->>'sourceRecordId' IS DISTINCT FROM input->'purchase'->>'id'
     OR f->>'currency' IS DISTINCT FROM a->'calculation'->>'currency'
     OR coalesce(length(f->>'invoiceEvidenceId'),0)=0)
 THEN RETURN false; END IF;
 RETURN true;
EXCEPTION WHEN data_exception THEN RETURN false;
END $$;
REVOKE ALL ON FUNCTION public.member_monthly_unchanged_price_carry(jsonb,jsonb) FROM PUBLIC,anon,authenticated,service_role;
DO $$
DECLARE definition text; old_guard text:=$old$    OR a->'calculation'->'finance'->'available'->>'netMinor' IS DISTINCT FROM '0'
    OR a->'calculation'->'finance'->'available'->>'vatMinor' IS DISTINCT FROM '0'$old$;
BEGIN
 definition:=pg_get_functiondef('public.finalize_member_monthly_amendment_verified(uuid,uuid,uuid,text)'::regprocedure);
 IF strpos(definition,old_guard)=0 THEN RAISE EXCEPTION 'Unexpected fixed monthly finalizer contract'; END IF;
 EXECUTE replace(definition,old_guard,$new$    OR ((a->'calculation'->'finance'->'available'->>'netMinor' IS DISTINCT FROM '0'
      OR a->'calculation'->'finance'->'available'->>'vatMinor' IS DISTINCT FROM '0')
      AND NOT public.member_monthly_unchanged_price_carry(a,input))$new$);
END $$;
NOTIFY pgrst,'reload schema';
COMMIT;
