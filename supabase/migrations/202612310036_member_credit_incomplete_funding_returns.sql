-- An unresolved debit must not be omitted from the accounting return basis.
BEGIN;
DO $$
DECLARE definition text;
BEGIN
 definition:=pg_get_functiondef('public.member_credit_return_context(uuid,uuid,text,bigint)'::regprocedure);
 IF (length(definition)-length(replace(definition,'BEGIN','')))/5<>1 THEN
  RAISE EXCEPTION 'Unexpected member-credit return context contract';
 END IF;
 EXECUTE replace(definition,'BEGIN',$guard$
 BEGIN
  IF EXISTS(
   SELECT 1 FROM public.member_credit_funding_claim claim
   WHERE claim.tenant_id=p_tenant_id AND claim.allocation_id=p_allocation_id
    AND NOT EXISTS(SELECT 1 FROM public.member_credit_redemption receipt
     WHERE receipt.tenant_id=claim.tenant_id AND receipt.allocation_id=claim.allocation_id
      AND receipt.reference=claim.reference)
  ) THEN
   RAISE EXCEPTION 'Reconcile outstanding funding claims before returning membership credit' USING ERRCODE='40001';
  END IF;
 $guard$);
END $$;
NOTIFY pgrst,'reload schema';
COMMIT;
