-- Private submission fence. Legacy processing rows are deliberately not backfilled.
CREATE TABLE IF NOT EXISTS public.campaign_batch_claim (
 token uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 recipient_id uuid NOT NULL REFERENCES public.email_campaign_recipient(id) ON DELETE CASCADE,
 campaign_id uuid NOT NULL REFERENCES public.email_campaign(id) ON DELETE CASCADE,
 claimed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 submission_started_at timestamptz,
 released_at timestamptz
);
ALTER TABLE public.campaign_batch_claim ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.campaign_batch_claim FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.campaign_batch_claim TO service_role;
CREATE UNIQUE INDEX IF NOT EXISTS campaign_batch_claim_active_recipient
 ON public.campaign_batch_claim(recipient_id) WHERE released_at IS NULL;

CREATE OR REPLACE FUNCTION public.campaign_claim_batch_recipient(p_campaign_id uuid,p_recipient_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE r public.email_campaign_recipient; t uuid;
BEGIN
 UPDATE public.email_campaign_recipient SET status='processing'
 WHERE id=p_recipient_id AND campaign_id=p_campaign_id AND status='pending'
 AND EXISTS(SELECT FROM public.email_campaign WHERE id=p_campaign_id AND status='sending')
 RETURNING * INTO r;
 IF NOT FOUND THEN RETURN NULL; END IF;
 INSERT INTO public.campaign_batch_claim(recipient_id,campaign_id) VALUES(r.id,p_campaign_id) RETURNING token INTO t;
 RETURN to_jsonb(r)||jsonb_build_object('_claim_token',t);
END $$;

CREATE OR REPLACE FUNCTION public.campaign_transition_batch_claims(p_tokens uuid[],p_action text)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE n integer; j public.campaign_batch_claim; changed integer;
BEGIN
 IF p_action NOT IN ('submit','release') OR cardinality(p_tokens) NOT BETWEEN 1 AND 100
 OR cardinality(p_tokens)<>(SELECT count(DISTINCT x) FROM unnest(p_tokens) x)
 THEN RAISE EXCEPTION 'Invalid batch transition'; END IF;
 n:=0;
 FOR j IN SELECT * FROM public.campaign_batch_claim WHERE token=ANY(p_tokens) ORDER BY recipient_id FOR UPDATE LOOP
  IF j.released_at IS NOT NULL OR j.submission_started_at IS NOT NULL
   OR j.claimed_at<clock_timestamp()-interval '15 minutes' THEN RAISE EXCEPTION 'Claim is no longer owned'; END IF;
  PERFORM FROM public.email_campaign_recipient r WHERE r.id=j.recipient_id AND r.campaign_id=j.campaign_id
    AND r.status='processing' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Recipient is no longer owned'; END IF;
  IF p_action='submit' THEN
   PERFORM FROM public.email_campaign WHERE id=j.campaign_id AND status='sending' FOR SHARE;
   IF NOT FOUND THEN RAISE EXCEPTION 'Campaign is not sending'; END IF;
   UPDATE public.campaign_batch_claim SET submission_started_at=clock_timestamp() WHERE token=j.token;
  ELSE
   UPDATE public.email_campaign_recipient SET status='pending' WHERE id=j.recipient_id;
   UPDATE public.campaign_batch_claim SET released_at=clock_timestamp() WHERE token=j.token;
  END IF;
  n:=n+1;
 END LOOP;
 IF n<>cardinality(p_tokens) THEN RAISE EXCEPTION 'Incomplete claim set'; END IF;
 RETURN n;
END $$;

CREATE OR REPLACE FUNCTION public.campaign_recover_unsubmitted_claims(p_campaign_id uuid)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE j public.campaign_batch_claim; n integer:=0;
BEGIN
 FOR j IN SELECT * FROM public.campaign_batch_claim WHERE campaign_id=p_campaign_id
  AND released_at IS NULL AND submission_started_at IS NULL
  AND claimed_at<clock_timestamp()-interval '15 minutes'
  ORDER BY recipient_id LIMIT 100 FOR UPDATE SKIP LOCKED LOOP
  UPDATE public.email_campaign_recipient SET status='pending'
   WHERE id=j.recipient_id AND campaign_id=p_campaign_id AND status='processing'
   AND sent_at IS NULL AND mailgun_message_id IS NULL
   AND EXISTS(SELECT FROM public.email_campaign WHERE id=p_campaign_id AND status='sending');
  IF FOUND THEN
   UPDATE public.campaign_batch_claim SET released_at=clock_timestamp() WHERE token=j.token;
   n:=n+1;
  END IF;
 END LOOP;
 RETURN n;
END $$;
REVOKE ALL ON FUNCTION public.campaign_claim_batch_recipient(uuid,uuid),
 public.campaign_transition_batch_claims(uuid[],text), public.campaign_recover_unsubmitted_claims(uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.campaign_claim_batch_recipient(uuid,uuid),
 public.campaign_transition_batch_claims(uuid[],text), public.campaign_recover_unsubmitted_claims(uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.campaign_finalize_delivery(p_campaign_id uuid,p_tenant_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE c public.email_campaign; total integer; submitted integer; failures integer; terminal boolean; final_status text;
BEGIN
 SELECT * INTO c FROM public.email_campaign WHERE id=p_campaign_id AND tenant_id=p_tenant_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Campaign not found'; END IF;
 IF c.status<>'sending' THEN RETURN jsonb_build_object('complete',false,'status',c.status); END IF;
 SELECT count(*),
  count(*) FILTER(WHERE status IN ('sent','delivered','opened','clicked','bounced','complained')
    OR (status='unsubscribed' AND (sent_at IS NOT NULL OR mailgun_message_id IS NOT NULL))),
  count(*) FILTER(WHERE status='failed'),
  bool_and(status IN ('sent','delivered','opened','clicked','bounced','complained','cancelled','unsubscribed','failed'))
 INTO total,submitted,failures,terminal FROM public.email_campaign_recipient WHERE campaign_id=p_campaign_id;
 IF total=0 OR total<>c.total_recipients OR terminal IS DISTINCT FROM true THEN
  RETURN jsonb_build_object('complete',false,'status','sending');
 END IF;
 final_status:=CASE WHEN submitted=0 AND failures>0 THEN 'failed' ELSE 'sent' END;
 UPDATE public.email_campaign SET status=final_status,sent_count=submitted,
  completed_at=clock_timestamp(),updated_at=clock_timestamp() WHERE id=p_campaign_id AND tenant_id=p_tenant_id;
 RETURN jsonb_build_object('complete',true,'status',final_status,'sent',submitted,'failed',failures);
END $$;
REVOKE ALL ON FUNCTION public.campaign_finalize_delivery(uuid,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.campaign_finalize_delivery(uuid,uuid) TO service_role;

CREATE TABLE IF NOT EXISTS public.campaign_acceptance_check (
 recipient_id uuid PRIMARY KEY REFERENCES public.email_campaign_recipient(id) ON DELETE CASCADE,
 checked_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 provider_evidence jsonb
);
ALTER TABLE public.campaign_acceptance_check ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.campaign_acceptance_check FROM PUBLIC,anon,authenticated;
GRANT ALL ON public.campaign_acceptance_check TO service_role;
CREATE OR REPLACE FUNCTION public.campaign_acceptance_candidates(p_campaign_id uuid,p_tenant_id uuid)
RETURNS SETOF jsonb LANGUAGE sql SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT to_jsonb(r) FROM public.email_campaign_recipient r
 JOIN public.email_campaign c ON c.id=r.campaign_id AND c.tenant_id=p_tenant_id
 LEFT JOIN public.campaign_acceptance_check x ON x.recipient_id=r.id
 WHERE r.campaign_id=p_campaign_id AND r.status='processing'
 AND c.status IN ('sending','paused') AND c.sent_at<clock_timestamp()-interval '15 minutes'
 ORDER BY x.checked_at NULLS FIRST,r.id LIMIT 10;
$$;
REVOKE ALL ON FUNCTION public.campaign_acceptance_candidates(uuid,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.campaign_acceptance_candidates(uuid,uuid) TO service_role;
