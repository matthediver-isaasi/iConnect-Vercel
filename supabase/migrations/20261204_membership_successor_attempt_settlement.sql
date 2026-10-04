BEGIN;
-- Preserve every existing commitment guard; extend only its PI identity check.
-- Fail closed if the installed function no longer contains the reviewed clause.
DO $migration$
DECLARE definition text; original text; replacement text;
BEGIN
  SELECT pg_get_functiondef('public.enforce_rolling_membership_commitment()'::regprocedure) INTO definition;
  original := $old$OR payment_quote->>'stripe_payment_intent_id' IS DISTINCT FROM r->>'stripe_payment_intent_id'$old$;
  replacement := $new$OR (payment_quote->>'stripe_payment_intent_id' IS DISTINCT FROM r->>'stripe_payment_intent_id'
          AND NOT EXISTS (
            SELECT 1 FROM public.membership_successor_payment_attempt attempt
            JOIN public.membership_successor_election election
              ON election.payment_quote_id=attempt.quote_id AND election.tenant_id=attempt.tenant_id
            WHERE attempt.quote_id=(payment_quote->>'id')::uuid
              AND attempt.tenant_id=tenant
              AND attempt.provider_intent_id=r->>'stripe_payment_intent_id'
              AND election.status='reserved' AND election.origin='form'
              AND election.payment_method='upfront'
              AND payment_quote#>>'{quote,simResult,formRenewalElectionId}'=election.id::text
          ))$new$;
  IF strpos(definition,original)=0 OR strpos(substr(definition,strpos(definition,original)+length(original)),original)>0 THEN
    RAISE EXCEPTION 'Installed upfront settlement contract differs from the reviewed clause';
  END IF;
  EXECUTE replace(definition,original,replacement);
END $migration$;
COMMIT;