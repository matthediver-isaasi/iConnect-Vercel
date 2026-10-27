BEGIN;
CREATE FUNCTION public.member_monthly_prepaid_cash_carry(a jsonb,input jsonb)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,public AS $$
DECLARE c jsonb:=a->'calculation'; f jsonb:=c->'finance';
 paid bigint; consumed bigint; available bigint; future bigint;
BEGIN
 IF a->'monthlyExecution'->>'prepaidCashCarry' IS DISTINCT FROM 'true'
 OR c->>'behaviour' IS DISTINCT FROM 'retain_term'
 OR c->>'action' IS DISTINCT FROM 'change'
 OR f->'blockers' IS DISTINCT FROM '[]'::jsonb
 OR f->'voucherFunding' IS DISTINCT FROM '[]'::jsonb
 OR f->>'personalFundingOnly' IS DISTINCT FROM 'true'
 OR jsonb_typeof(a->'fundingEvidence'->'settledFunding') IS DISTINCT FROM 'array'
 THEN RETURN false; END IF;
 paid:=(f->'settled'->>'grossMinor')::bigint;
 consumed:=(f->'consumed'->>'grossMinor')::bigint;
 available:=(f->'available'->>'grossMinor')::bigint;
 future:=(c->>'futureObligationMinor')::bigint;
 IF paid IS NULL OR consumed IS NULL OR available IS NULL OR future IS NULL
 OR paid<=0 OR consumed<0 OR available<=0 OR future<=0 OR paid-consumed<>available
 OR (c->>'surplusMinor')::bigint IS DISTINCT FROM 0
 OR (c->'newCost'->>'grossMinor')::bigint IS DISTINCT FROM future+available
 OR (a->'monthlyExecution'->'providerTarget'->>'termTotalMinor')::bigint IS DISTINCT FROM paid+future
 OR (a->'monthlyExecution'->'providerFunding'->>'settledGrossMinor')::bigint IS DISTINCT FROM paid
 OR EXISTS(SELECT 1 FROM jsonb_array_elements(jsonb_build_array(
    f->'original',f->'settled',f->'consumed',f->'available',c->'targetFullPrice',c->'newCost')) p
   WHERE (p->>'vatMinor')::bigint IS DISTINCT FROM 0
     OR (p->>'netMinor')::bigint IS DISTINCT FROM (p->>'grossMinor')::bigint)
 OR (SELECT coalesce(sum((p->>'grossMinor')::bigint),0)
     FROM jsonb_array_elements(a->'fundingEvidence'->'settledFunding') p) IS DISTINCT FROM paid
 OR EXISTS(SELECT 1 FROM jsonb_array_elements(a->'fundingEvidence'->'settledFunding') p
   WHERE p->>'kind' IS DISTINCT FROM 'cash' OR p->>'ownerType' IS DISTINCT FROM 'member'
    OR p->>'ownerId' IS DISTINCT FROM input->'purchase'->>'member_id'
    OR p->>'sourceRecordId' IS DISTINCT FROM input->'purchase'->>'id'
    OR p->>'currency' IS DISTINCT FROM c->>'currency'
    OR p->>'state' IS DISTINCT FROM 'settled'
    OR coalesce(length(p->>'invoiceEvidenceId'),0)=0
    OR coalesce(length(p->>'nominalCode'),0)=0 OR coalesce(length(p->>'taxType'),0)=0
    OR p->>'nominalCode' IS DISTINCT FROM coalesce(a->'targetBandSnapshot'->>'nominal_code',a->'targetSnapshot'->>'nominal_code')
    OR p->>'taxType' IS DISTINCT FROM coalesce(a->'targetBandSnapshot'->>'vat_rate',a->'targetSnapshot'->>'flat_vat_rate')
    OR (p->>'vatMinor')::bigint IS DISTINCT FROM 0
    OR (p->>'netMinor')::bigint IS DISTINCT FROM (p->>'grossMinor')::bigint)
 THEN RETURN false; END IF;
 RETURN true;
EXCEPTION WHEN data_exception THEN RETURN false;
END $$;
REVOKE ALL ON FUNCTION public.member_monthly_prepaid_cash_carry(jsonb,jsonb) FROM PUBLIC,anon,authenticated,service_role;
DO $$
DECLARE definition text; marker text:='AND NOT public.member_monthly_unchanged_price_carry(a,input)';
BEGIN
 definition:=pg_get_functiondef('public.finalize_member_monthly_amendment_verified(uuid,uuid,uuid,text)'::regprocedure);
 IF strpos(definition,marker)=0 THEN RAISE EXCEPTION 'Unexpected monthly finalizer contract'; END IF;
 EXECUTE replace(definition,marker,
  'AND NOT (public.member_monthly_unchanged_price_carry(a,input) OR public.member_monthly_prepaid_cash_carry(a,input))');
END $$;
NOTIFY pgrst,'reload schema';
COMMIT;
