-- Apply after campaign preparation and delivery transport migrations.
-- No historical campaigns or recipient rows are rewritten.
BEGIN;
ALTER TABLE public.email_campaign
  ADD COLUMN IF NOT EXISTS delivery_transport_pinned_at timestamptz;

CREATE OR REPLACE FUNCTION public.prevent_campaign_transport_change()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  -- Only the first atomic preparation claim may select a transport. In
  -- particular, a draft with ANY residual recipients must be reconciled first.
  IF OLD.status IN ('draft','scheduled') AND NEW.status = 'preparing'
    AND OLD.delivery_transport_pinned_at IS NULL
    AND OLD.preparation_generation IS NULL
    AND NOT EXISTS (SELECT 1 FROM public.email_campaign_recipient WHERE campaign_id=OLD.id)
  THEN
    NEW.delivery_transport_pinned_at := clock_timestamp();
  ELSIF NEW.delivery_transport IS DISTINCT FROM OLD.delivery_transport
    OR NEW.delivery_transport_pinned_at IS DISTINCT FROM OLD.delivery_transport_pinned_at
  THEN
    RAISE EXCEPTION 'Campaign delivery transport is fixed after first preparation';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.prevent_campaign_transport_change() FROM PUBLIC;
DROP TRIGGER IF EXISTS email_campaign_transport_immutable ON public.email_campaign;
CREATE TRIGGER email_campaign_transport_immutable
BEFORE UPDATE OF status, delivery_transport, delivery_transport_pinned_at ON public.email_campaign
FOR EACH ROW EXECUTE FUNCTION public.prevent_campaign_transport_change();

-- Keep the seven-argument function for older deployments. Its status claim
-- pins its existing transport. New workers use this explicit internal overload.
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
    sent_count=0, total_recipients=0, sent_at=now(), updated_at=clock_timestamp()
    WHERE id=c.id RETURNING * INTO c;
  INSERT INTO campaign_preparation(id,campaign_id,tenant_id,campaign_version,snapshot)
    VALUES(p_generation,c.id,c.tenant_id,c.updated_at,to_jsonb(c));
  RETURN to_jsonb(c);
END $$;
REVOKE ALL ON FUNCTION public.campaign_preparation_begin(uuid,uuid,timestamptz,text,timestamptz,uuid,uuid,text)
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.campaign_preparation_begin(uuid,uuid,timestamptz,text,timestamptz,uuid,uuid,text)
  TO service_role;
COMMIT;
