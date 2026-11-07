BEGIN;
-- First-term instalments remain due independently of a genuine next-term
-- election. Preserve the original joining guard and permit only that separately
-- authorized, non-overlapping successor.
DO $$
DECLARE definition text;
anchor text := '  -- A completed first term must not prevent a genuinely later renewal.';
addition text := $addition$
  IF EXISTS (
    SELECT 1 FROM public.membership_fee_token t
    JOIN public.member_membership_history h ON h.id=t.history_record_id
    JOIN public.membership_successor_election e ON e.previous_term_id=h.id
      AND e.tenant_id=b.tenant_id AND e.member_id=b.member_id
      AND e.organization_id IS NULL AND e.status='reserved'
    WHERE t.id=b.fee_token_id AND h.tenant_id=b.tenant_id AND h.member_id=b.member_id
      AND e.term_start_date>h.term_end_date
      AND e.id::text=coalesce(to_jsonb(NEW)->>'membership_successor_election_id',
        to_jsonb(NEW)#>>'{quote,simResult,formRenewalElectionId}')
      AND e.term_start_date=(CASE WHEN TG_TABLE_NAME='membership_payment_quote'
        THEN to_jsonb(NEW)#>>'{quote,simResult,membershipYear,start}'
        ELSE coalesce(to_jsonb(NEW)#>>'{metadata,dd,commitment,term_start_date}',
          to_jsonb(NEW)#>>'{metadata,card,commitment,term_start_date}') END)::date
      AND e.term_end_date=(CASE WHEN TG_TABLE_NAME='membership_payment_quote'
        THEN to_jsonb(NEW)#>>'{quote,simResult,membershipYear,end}'
        ELSE coalesce(to_jsonb(NEW)#>>'{metadata,dd,commitment,term_end_date}',
          to_jsonb(NEW)#>>'{metadata,card,commitment,term_end_date}') END)::date
  ) THEN RETURN NEW; END IF;
$addition$;
BEGIN
  definition:=pg_get_functiondef('public.guard_form_joining_voucher_payment()'::regprocedure);
  IF position('JOIN public.membership_successor_election e' IN definition)>0 THEN RETURN; END IF;
  IF (length(definition)-length(replace(definition,anchor,'')))/length(anchor)<>1 THEN
    RAISE EXCEPTION 'Unexpected first-membership payment guard';
  END IF;
  EXECUTE replace(definition,anchor,addition||anchor);
END $$;
COMMIT;
