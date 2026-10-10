BEGIN;
-- Do not delete raw evidence or infer human intent. Preserve old mixed counters
-- before replacing them with counts supported by retained iConnect requests.
LOCK TABLE public.email_link_click, public.email_campaign_recipient,
  public.email_campaign, public.email_event IN SHARE ROW EXCLUSIVE MODE;
ALTER TABLE public.email_campaign_recipient
  ADD COLUMN IF NOT EXISTS legacy_mixed_click_count integer,
  ADD COLUMN IF NOT EXISTS legacy_mixed_clicked_at timestamptz,
  ADD COLUMN IF NOT EXISTS click_evidence_reconciled_at timestamptz;
CREATE TEMP TABLE campaign_click_reconciliation ON COMMIT DROP AS
SELECT r.id,coalesce(l.n,0)::integer AS n,l.first_click
FROM public.email_campaign_recipient r
LEFT JOIN (
  SELECT recipient_id,campaign_id,count(*) AS n,min(coalesce(clicked_at,created_at)) AS first_click
  FROM public.email_link_click GROUP BY recipient_id,campaign_id
) l ON l.recipient_id=r.id AND l.campaign_id=r.campaign_id
WHERE r.click_evidence_reconciled_at IS NULL;
UPDATE public.email_campaign_recipient r SET
  legacy_mixed_click_count = r.click_count,
  legacy_mixed_clicked_at = r.clicked_at,
  click_evidence_reconciled_at = now(),
  click_count = evidence.n,
  clicked_at = evidence.first_click
FROM campaign_click_reconciliation evidence
WHERE r.id=evidence.id;
UPDATE public.email_campaign c SET clicked_count = evidence.n
FROM (
  SELECT c2.id,count(r.id)::integer AS n FROM public.email_campaign c2
  LEFT JOIN public.email_campaign_recipient r ON r.campaign_id=c2.id AND r.click_count>0
  GROUP BY c2.id
) evidence WHERE c.id=evidence.id;

CREATE OR REPLACE FUNCTION public.count_iconnect_link_request()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE r public.email_campaign_recipient%ROWTYPE;
BEGIN
  SELECT * INTO r FROM public.email_campaign_recipient WHERE id=NEW.recipient_id FOR UPDATE;
  IF NOT FOUND OR r.campaign_id IS DISTINCT FROM NEW.campaign_id THEN
    RAISE EXCEPTION 'Click recipient/campaign mismatch';
  END IF;
  UPDATE public.email_campaign_recipient SET
    click_count=coalesce(click_count,0)+1,
    clicked_at=coalesce(clicked_at,NEW.clicked_at,NEW.created_at,now()),
    delivered_at=coalesce(delivered_at,NEW.clicked_at,NEW.created_at,now()),
    status=CASE WHEN status IN ('pending','sending','processing','sent','delivered','opened') THEN 'clicked' ELSE status END
  WHERE id=r.id;
  UPDATE public.email_campaign SET
    clicked_count=coalesce(clicked_count,0)+CASE WHEN coalesce(r.click_count,0)=0 THEN 1 ELSE 0 END,
    delivered_count=coalesce(delivered_count,0)+CASE WHEN r.delivered_at IS NULL THEN 1 ELSE 0 END
  WHERE id=r.campaign_id;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS count_iconnect_link_request ON public.email_link_click;
CREATE TRIGGER count_iconnect_link_request AFTER INSERT ON public.email_link_click
FOR EACH ROW EXECUTE FUNCTION public.count_iconnect_link_request();
REVOKE ALL ON FUNCTION public.count_iconnect_link_request() FROM PUBLIC,anon,authenticated;
-- Prevent a stale application/sync worker from replacing the atomic result.
CREATE OR REPLACE FUNCTION public.guard_iconnect_click_counts()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
  IF pg_trigger_depth() = 1 THEN
    NEW.click_count := OLD.click_count;
    NEW.clicked_at := OLD.clicked_at;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS guard_iconnect_click_counts ON public.email_campaign_recipient;
CREATE TRIGGER guard_iconnect_click_counts BEFORE UPDATE ON public.email_campaign_recipient
FOR EACH ROW EXECUTE FUNCTION public.guard_iconnect_click_counts();
REVOKE ALL ON FUNCTION public.guard_iconnect_click_counts() FROM PUBLIC,anon,authenticated;

-- Historically forged/mismatched tokens remain evidence, but not counted links.
CREATE OR REPLACE VIEW public.email_counted_link_click AS
SELECT l.* FROM public.email_link_click l JOIN public.email_campaign_recipient r
ON r.id=l.recipient_id AND r.campaign_id=l.campaign_id;
REVOKE ALL ON public.email_counted_link_click FROM PUBLIC,anon,authenticated;
GRANT SELECT ON public.email_counted_link_click TO service_role;
REVOKE INSERT,UPDATE,DELETE ON public.email_link_click FROM anon,authenticated;

-- Keep existing duplicates for audit. Suppress future provider-click replays
-- across webhook and sync without removing or rewriting the original payload.
CREATE INDEX IF NOT EXISTS email_event_click_identity ON public.email_event
  (mailgun_event_id,mailgun_message_id,email) WHERE event_type='clicked';
CREATE OR REPLACE FUNCTION public.dedupe_mailgun_click_evidence()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE identity_key text;
BEGIN
  IF NEW.event_type <> 'clicked' THEN RETURN NEW; END IF;
  identity_key := concat_ws(':',NEW.mailgun_event_id,NEW.mailgun_message_id,NEW.email);
  IF nullif(NEW.mailgun_event_id,'') IS NULL THEN
    -- Missing provider IDs cannot prove distinct events. Identical raw payloads
    -- are retries; different payloads remain evidence, never counted clicks.
    identity_key := coalesce(NEW.raw_event::text,'null');
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(identity_key,5070));
  IF EXISTS (SELECT 1 FROM public.email_event e WHERE e.event_type='clicked'
    AND e.mailgun_message_id IS NOT DISTINCT FROM NEW.mailgun_message_id
    AND e.email IS NOT DISTINCT FROM NEW.email
    AND ((nullif(NEW.mailgun_event_id,'') IS NOT NULL AND e.mailgun_event_id=NEW.mailgun_event_id)
      OR (nullif(NEW.mailgun_event_id,'') IS NULL AND e.raw_event IS NOT DISTINCT FROM NEW.raw_event)))
  THEN RETURN NULL; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS dedupe_mailgun_click_evidence ON public.email_event;
CREATE TRIGGER dedupe_mailgun_click_evidence BEFORE INSERT ON public.email_event
FOR EACH ROW EXECUTE FUNCTION public.dedupe_mailgun_click_evidence();
REVOKE ALL ON FUNCTION public.dedupe_mailgun_click_evidence() FROM PUBLIC,anon,authenticated;
NOTIFY pgrst,'reload schema';
COMMIT;
