BEGIN;
-- Deliberately excludes access/lifecycle jobs until cancellation admission and
-- renewal-race safeguards are ready. Only an approved finance plan may run.
CREATE FUNCTION public.claim_member_cancellation_finance_jobs(p_limit integer DEFAULT 1)
RETURNS SETOF public.member_cancellation_job LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public AS $$
BEGIN
 UPDATE public.member_cancellation_job SET state='uncertain',last_error='Delivery outcome requires reconciliation'
 WHERE kind='notify_finance' AND state='claimed' AND claimed_at<now()-interval '5 minutes';
 RETURN QUERY
 WITH due AS (
  SELECT j.id FROM public.member_cancellation_job j
  JOIN public.member_cancellation_request r ON r.id=j.request_id
  JOIN public.member_cancellation_finance f ON f.request_id=r.id
   AND f.tenant_id=r.tenant_id AND f.member_id=r.member_id
  WHERE r.access_ended_at IS NOT NULL AND r.withdrawn_at IS NULL
   AND j.next_attempt_at<=now()
   AND (j.state='pending' OR (j.kind='finance' AND j.state='claimed' AND j.claimed_at<now()-interval '2 minutes'))
   AND (j.kind='finance' OR (j.kind='notify_finance' AND r.financial_state='settled'))
  ORDER BY j.next_attempt_at,j.id FOR UPDATE OF j SKIP LOCKED
  LIMIT greatest(1,least(COALESCE(p_limit,1),5))
 )
 UPDATE public.member_cancellation_job j SET state='claimed',claim_token=gen_random_uuid(),claimed_at=now()
 FROM due WHERE j.id=due.id RETURNING j.*;
END $$;
REVOKE ALL ON FUNCTION public.claim_member_cancellation_finance_jobs(integer) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.claim_member_cancellation_finance_jobs(integer) TO service_role;
NOTIFY pgrst,'reload schema';
COMMIT;
