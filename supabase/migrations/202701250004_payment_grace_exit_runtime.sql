-- This grants no tenant/plan rollout authority. Both the release and exact
-- plan approval are still required by the function and are empty on install.
BEGIN;
SET LOCAL lock_timeout='5s';
DO $$
BEGIN
  IF to_regprocedure('public.membership_payment_grace_exit_evidence(uuid,uuid,uuid)') IS NULL
    OR position('payment_exit' IN pg_get_functiondef(
      'public.reserve_post_grace_renewal(uuid,uuid,uuid,uuid,text,bigint,text,jsonb)'::regprocedure))=0
    OR position('membership_payment_grace_exit_evidence' IN pg_get_functiondef(
      'public.apply_post_grace_record_dates(uuid,uuid,uuid,text,text,text,timestamptz,bigint,text,jsonb)'::regprocedure))=0 THEN
    RAISE EXCEPTION 'Payment grace expiry renewal safeguards must be installed before runtime access';
  END IF;
END $$;
REVOKE ALL ON FUNCTION public.apply_membership_payment_grace_exit(uuid,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.apply_membership_payment_grace_exit(uuid,uuid) TO service_role;
COMMIT;
