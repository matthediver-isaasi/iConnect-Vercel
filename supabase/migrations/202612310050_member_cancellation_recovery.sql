BEGIN;
CREATE TABLE public.member_cancellation_job(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 request_id uuid NOT NULL REFERENCES public.member_cancellation_request(id),
 kind text NOT NULL CHECK(kind IN ('lifecycle','finance','notify_access','notify_finance')),
 state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','claimed','uncertain','done','manual_review')),
 next_attempt_at timestamptz NOT NULL DEFAULT now(),
 claim_token uuid,claimed_at timestamptz,last_error text,result jsonb,
 UNIQUE(request_id,kind)
);
ALTER TABLE public.member_cancellation_job ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.member_cancellation_job FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.member_cancellation_job TO service_role;
CREATE INDEX member_cancellation_jobs_due ON public.member_cancellation_job(next_attempt_at,id)
 WHERE state IN ('pending','claimed');

CREATE FUNCTION public.enqueue_member_cancellation_jobs()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
 IF TG_OP='INSERT' THEN
  INSERT INTO public.member_cancellation_job(request_id,kind,next_attempt_at)
  VALUES(NEW.id,'lifecycle',NEW.effective_date::timestamp AT TIME ZONE 'UTC') ON CONFLICT DO NOTHING;
 END IF;
 IF NEW.access_ended_at IS NOT NULL THEN
  INSERT INTO public.member_cancellation_job(request_id,kind)
  VALUES(NEW.id,'finance'),(NEW.id,'notify_access') ON CONFLICT DO NOTHING;
 END IF;
 IF NEW.financial_state='settled' THEN
  INSERT INTO public.member_cancellation_job(request_id,kind)
  VALUES(NEW.id,'notify_finance') ON CONFLICT DO NOTHING;
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.enqueue_member_cancellation_jobs() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER member_cancellation_recovery_enqueue
 AFTER INSERT OR UPDATE OF access_ended_at,financial_state ON public.member_cancellation_request
 FOR EACH ROW EXECUTE FUNCTION public.enqueue_member_cancellation_jobs();

CREATE FUNCTION public.claim_member_cancellation_jobs(p_limit integer DEFAULT 10)
RETURNS SETOF public.member_cancellation_job LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
 -- A mail provider may have accepted an expired send claim. Do not send again.
 UPDATE public.member_cancellation_job SET state='uncertain',last_error='Delivery outcome requires reconciliation'
 WHERE kind IN ('notify_access','notify_finance') AND state='claimed' AND claimed_at<now()-interval '5 minutes';
 RETURN QUERY
 WITH due AS (
  SELECT j.id FROM public.member_cancellation_job j
  WHERE j.next_attempt_at<=now() AND (j.state='pending'
   OR (j.kind IN ('lifecycle','finance') AND j.state='claimed' AND j.claimed_at<now()-interval '2 minutes'))
  ORDER BY j.next_attempt_at,j.id FOR UPDATE SKIP LOCKED LIMIT greatest(1,least(COALESCE(p_limit,10),20))
 )
 UPDATE public.member_cancellation_job j SET state='claimed',claim_token=gen_random_uuid(),claimed_at=now()
 FROM due WHERE j.id=due.id RETURNING j.*;
END $$;

CREATE FUNCTION public.finish_member_cancellation_job(
 p_id uuid,p_claim_token uuid,p_state text,p_error text DEFAULT NULL,p_delay_seconds integer DEFAULT 60,
 p_result jsonb DEFAULT '{}'::jsonb)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE j public.member_cancellation_job;
BEGIN
 SELECT * INTO j FROM public.member_cancellation_job WHERE id=p_id FOR UPDATE;
 IF NOT FOUND OR j.state<>'claimed' OR j.claim_token IS DISTINCT FROM p_claim_token THEN RETURN false; END IF;
 IF p_state NOT IN ('done','pending','uncertain','manual_review')
  OR (j.kind IN ('notify_access','notify_finance') AND p_state='pending'
   AND p_result->'notSubmitted' IS DISTINCT FROM 'true'::jsonb)
 THEN RAISE EXCEPTION 'A delivery claim cannot be retried without outcome evidence'; END IF;
 IF j.kind IN ('notify_access','notify_finance') AND p_state='done'
  AND length(COALESCE(p_result->>'messageId','')) NOT BETWEEN 1 AND 1000 THEN
  RAISE EXCEPTION 'Accepted notification needs its provider message identity';
 END IF;
 UPDATE public.member_cancellation_job SET state=p_state,last_error=left(p_error,500),result=p_result,
  next_attempt_at=now()+make_interval(secs=>greatest(5,least(COALESCE(p_delay_seconds,60),86400)))
 WHERE id=p_id;
 RETURN true;
END $$;
REVOKE ALL ON FUNCTION public.claim_member_cancellation_jobs(integer),
 public.finish_member_cancellation_job(uuid,uuid,text,text,integer,jsonb) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.claim_member_cancellation_jobs(integer),
 public.finish_member_cancellation_job(uuid,uuid,text,text,integer,jsonb) TO service_role;
NOTIFY pgrst,'reload schema';
COMMIT;
