-- Unused/unposted portions do not need an accounting debit reversal. Claims
-- and release still serialize on the purchase lock; new claims cannot follow
-- release. The existing transition routine restores only unreturned value.
BEGIN;
DO $$
DECLARE definition text;
 needle text:='AND a.amount_minor>coalesce((SELECT sum(r.cumulative_minor)';
BEGIN
 SELECT pg_get_functiondef('public.voucher_credit_transition(uuid,text,text,text)'::regprocedure)
 INTO definition;
 IF strpos(definition,needle)=0 THEN
  RAISE EXCEPTION 'Unexpected claimed funding release contract';
 END IF;
 EXECUTE replace(definition,needle,
  'AND (SELECT sum((f.context->>''amountMinor'')::bigint)
    FROM public.member_credit_funding_claim f
    WHERE f.tenant_id=a.tenant_id AND f.allocation_id=a.id)
   >coalesce((SELECT sum(r.cumulative_minor)');
END $$;
NOTIFY pgrst,'reload schema';
COMMIT;
