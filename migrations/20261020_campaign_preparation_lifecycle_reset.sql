-- Forward-only: apply after 20261001_campaign_preparation.sql and
-- 20261017_campaign_transport_first_send.sql. No existing rows are rewritten.
BEGIN;

CREATE OR REPLACE FUNCTION public.campaign_preparation_begin(
  p_campaign uuid, p_tenant uuid, p_version timestamptz, p_status text,
  p_scheduled timestamptz, p_generation uuid, p_actor uuid DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE c email_campaign%rowtype;
BEGIN
  SELECT * INTO c FROM email_campaign WHERE id=p_campaign AND tenant_id=p_tenant FOR UPDATE;
  IF NOT FOUND OR c.status NOT IN ('draft','scheduled') OR c.status<>p_status
    OR c.updated_at IS DISTINCT FROM p_version OR c.scheduled_at IS DISTINCT FROM p_scheduled
    OR c.category_review_required IS TRUE THEN
    RAISE EXCEPTION 'Campaign preparation conflict';
  END IF;
  -- Older workers retain their transport, but may not replace an existing claim.
  IF c.preparation_generation IS NOT NULL OR c.delivery_transport_pinned_at IS NOT NULL
    OR EXISTS(SELECT 1 FROM email_campaign_recipient WHERE campaign_id=c.id) THEN
    RAISE EXCEPTION 'Existing campaign preparation or recipients require reconciliation before preparation';
  END IF;
  UPDATE email_campaign SET status='preparing', preparation_generation=p_generation,
    preparation_actor_member_id=p_actor,
    completed_at=NULL, cancelled_at=NULL, cancelled_by=NULL,
    paused_at=NULL, paused_by=NULL, pause_reason=NULL,
    sent_count=0, total_recipients=0, sent_at=now(), updated_at=clock_timestamp()
    WHERE id=c.id RETURNING * INTO c;
  INSERT INTO campaign_preparation(id,campaign_id,tenant_id,campaign_version,snapshot)
    VALUES(p_generation,c.id,c.tenant_id,c.updated_at,to_jsonb(c));
  RETURN to_jsonb(c);
END $$;

CREATE OR REPLACE FUNCTION public.campaign_preparation_begin(
  p_campaign uuid, p_tenant uuid, p_version timestamptz, p_status text,
  p_scheduled timestamptz, p_generation uuid, p_actor uuid, p_transport text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE c email_campaign%rowtype;
BEGIN
  SELECT * INTO c FROM email_campaign WHERE id=p_campaign AND tenant_id=p_tenant FOR UPDATE;
  IF NOT FOUND OR c.status NOT IN ('draft','scheduled') OR c.status<>p_status
    OR c.updated_at IS DISTINCT FROM p_version OR c.scheduled_at IS DISTINCT FROM p_scheduled
    OR c.category_review_required IS TRUE THEN
    RAISE EXCEPTION 'Campaign preparation conflict';
  END IF;
  IF c.preparation_generation IS NOT NULL OR c.delivery_transport_pinned_at IS NOT NULL
    OR EXISTS(SELECT 1 FROM email_campaign_recipient WHERE campaign_id=c.id) THEN
    RAISE EXCEPTION 'Existing campaign preparation or recipients require reconciliation before transport selection';
  END IF;
  IF p_transport IS NULL OR p_transport NOT IN ('individual','mailgun_batch_v1') THEN
    RAISE EXCEPTION 'Invalid campaign delivery transport';
  END IF;
  UPDATE email_campaign SET status='preparing', preparation_generation=p_generation,
    preparation_actor_member_id=p_actor, delivery_transport=p_transport,
    completed_at=NULL, cancelled_at=NULL, cancelled_by=NULL,
    paused_at=NULL, paused_by=NULL, pause_reason=NULL,
    sent_count=0, total_recipients=0, sent_at=now(), updated_at=clock_timestamp()
    WHERE id=c.id RETURNING * INTO c;
  INSERT INTO campaign_preparation(id,campaign_id,tenant_id,campaign_version,snapshot)
    VALUES(p_generation,c.id,c.tenant_id,c.updated_at,to_jsonb(c));
  RETURN to_jsonb(c);
END $$;

REVOKE ALL ON FUNCTION public.campaign_preparation_begin(uuid,uuid,timestamptz,text,timestamptz,uuid,uuid)
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.campaign_preparation_begin(uuid,uuid,timestamptz,text,timestamptz,uuid,uuid)
  TO service_role;
REVOKE ALL ON FUNCTION public.campaign_preparation_begin(uuid,uuid,timestamptz,text,timestamptz,uuid,uuid,text)
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.campaign_preparation_begin(uuid,uuid,timestamptz,text,timestamptz,uuid,uuid,text)
  TO service_role;
COMMIT;
