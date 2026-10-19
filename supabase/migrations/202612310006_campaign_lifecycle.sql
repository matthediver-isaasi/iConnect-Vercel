-- Offline-reviewed rollout only. No campaign delivery status is repurposed.
BEGIN;
ALTER TABLE public.email_campaign ADD COLUMN IF NOT EXISTS archived_at timestamptz;
CREATE INDEX IF NOT EXISTS email_campaign_archive_list ON public.email_campaign(tenant_id,archived_at);
-- Legacy permissive RLS policies do not constitute service-only authorization.
-- Preserve service_role's guarded group-draft delete, never browser deletes.
REVOKE DELETE ON public.email_campaign,public.email_campaign_recipient FROM PUBLIC,anon,authenticated;

-- Existing paused preparation snapshots predate archived_at. This metadata is
-- not delivery identity; the parent/child guards below independently enforce it.
CREATE OR REPLACE FUNCTION public.campaign_preparation_identity(value jsonb)
RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path=public AS $$
  SELECT value-array['status','updated_at','paused_at','paused_by','pause_reason',
    'sent_count','opened_count','clicked_count','delivered_count','failed_count','archived_at']
$$;
REVOKE ALL ON FUNCTION public.campaign_preparation_identity(jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.campaign_preparation_identity(jsonb) TO service_role;

-- A capability created only inside the security-definer lifecycle transaction.
CREATE TABLE IF NOT EXISTS public.campaign_lifecycle_permit (
  transaction_id bigint NOT NULL, campaign_id uuid NOT NULL,
  PRIMARY KEY(transaction_id,campaign_id)
);
REVOKE ALL ON public.campaign_lifecycle_permit FROM PUBLIC,anon,authenticated,service_role;
ALTER TABLE public.campaign_lifecycle_permit ENABLE ROW LEVEL SECURITY;

-- Test sends have no recipient claim. Hold a durable reservation across the
-- external provider call instead. Never expire uncertain provider acceptance:
-- a crashed request requires explicit operator reconciliation/release.
CREATE TABLE IF NOT EXISTS public.campaign_test_send_lease (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id uuid NOT NULL REFERENCES public.email_campaign(id) ON DELETE CASCADE,
  tenant_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS campaign_test_send_lease_campaign ON public.campaign_test_send_lease(campaign_id);
ALTER TABLE public.campaign_test_send_lease ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.campaign_test_send_lease FROM PUBLIC,anon,authenticated,service_role;

-- Preserve consent even when its originating campaign is removed.
DO $$
DECLARE fk record;
BEGIN
  FOR fk IN SELECT conname FROM pg_constraint
    WHERE conrelid='public.email_unsubscribe'::regclass
      AND confrelid='public.email_campaign'::regclass AND contype='f'
  LOOP EXECUTE format('ALTER TABLE public.email_unsubscribe DROP CONSTRAINT %I',fk.conname); END LOOP;
END $$;
ALTER TABLE public.email_unsubscribe ADD CONSTRAINT email_unsubscribe_campaign_id_fkey
  FOREIGN KEY(campaign_id) REFERENCES public.email_campaign(id) ON DELETE SET NULL;

CREATE OR REPLACE FUNCTION public.campaign_lifecycle_assert_idle(p_campaign uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
  IF EXISTS(SELECT 1 FROM public.campaign_test_send_lease WHERE campaign_id=p_campaign) THEN
    RAISE EXCEPTION 'Campaign has unresolved test-send work; an operator must reconcile provider delivery and release the test-send lease before lifecycle changes'
      USING ERRCODE='55000';
  END IF;
  IF EXISTS(SELECT 1 FROM public.email_campaign WHERE id=p_campaign
      AND status IN ('scheduled','preparing','sending','paused'))
    OR EXISTS(SELECT 1 FROM public.email_campaign_recipient WHERE campaign_id=p_campaign
      AND status IN ('pending','processing','sending'))
    OR EXISTS(SELECT 1 FROM public.campaign_preparation WHERE campaign_id=p_campaign
      AND (phase NOT IN ('complete','failed') OR lease_until>clock_timestamp()))
    OR EXISTS(SELECT 1 FROM public.campaign_survey_delivery WHERE campaign_id=p_campaign AND status='pending')
  THEN RAISE EXCEPTION 'Campaign has active or unresolved delivery work; stop scheduling/sending and reconcile pending recipients, preparation or provider delivery before lifecycle changes'
    USING ERRCODE='55000'; END IF;
END $$;

CREATE OR REPLACE FUNCTION public.guard_campaign_lifecycle()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE permitted boolean; old_content jsonb; new_content jsonb;
  mutable_fields text[]:=ARRAY[
    'archived_at','updated_at',
    'sent_count','delivered_count','opened_count','clicked_count','bounced_count',
    'unsubscribed_count','complained_count','failed_count',
    'category_review_required','category_review_reason','category_review_marked_at',
    'deleted_category_id','deleted_category_name'
  ];
BEGIN
  IF TG_OP='INSERT' THEN
    IF NEW.archived_at IS NOT NULL THEN
      RAISE EXCEPTION 'Use campaign lifecycle Archive' USING ERRCODE='55000';
    END IF;
    RETURN NEW;
  END IF;
  SELECT EXISTS(SELECT 1 FROM public.campaign_lifecycle_permit
    WHERE transaction_id=txid_current() AND campaign_id=OLD.id) INTO permitted;
  IF TG_OP='DELETE' THEN
    -- Preserve the existing tenant/group guarded draft-delete contract.
    IF NOT permitted AND (OLD.status<>'draft' OR OLD.archived_at IS NOT NULL) THEN
      RAISE EXCEPTION 'Use campaign lifecycle Delete' USING ERRCODE='55000';
    END IF;
    PERFORM public.campaign_lifecycle_assert_idle(OLD.id);
    IF EXISTS(SELECT 1 FROM public.campaign_survey_delivery WHERE campaign_id=OLD.id) THEN
      RAISE EXCEPTION 'Campaign has protected survey provenance; use Archive instead' USING ERRCODE='55000';
    END IF;
    DELETE FROM public.member_inbox_message_state s USING public.email_campaign_recipient r
      WHERE r.campaign_id=OLD.id AND s.recipient_id=r.id AND s.tenant_id=OLD.tenant_id;
    RETURN OLD;
  END IF;
  IF NEW.archived_at IS DISTINCT FROM OLD.archived_at AND NOT permitted THEN
    RAISE EXCEPTION 'Use campaign lifecycle Archive or Restore' USING ERRCODE='55000';
  END IF;
  IF NEW.archived_at IS NOT NULL AND NEW.status IN ('scheduled','preparing','sending','paused') THEN
    RAISE EXCEPTION 'Archived campaigns cannot enter delivery; Restore first' USING ERRCODE='55000';
  END IF;
  IF OLD.archived_at IS NOT NULL THEN
    -- Deny new/future content fields by default. Tracking counters remain
    -- writable for late webhooks and live-count enrichment. Lifecycle's private
    -- capability permits archive metadata only, not concurrent content edits.
    old_content:=to_jsonb(OLD)-mutable_fields;
    new_content:=to_jsonb(NEW)-mutable_fields;
    -- Category deletion may clear a now-invalid category and mark review.
    -- Never allow assigning/replacing an archived campaign's category.
    IF to_jsonb(NEW)->>'communication_category_id' IS NULL
      AND to_jsonb(NEW)->>'category_review_required'='true'
      AND to_jsonb(NEW)->>'deleted_category_id' IS NOT NULL
      AND to_jsonb(NEW)->'category_review_reason'->>'code'='deleted_communication_category' THEN
      old_content:=old_content-'communication_category_id';
      new_content:=new_content-'communication_category_id';
    END IF;
    IF new_content IS DISTINCT FROM old_content THEN
      RAISE EXCEPTION 'Archived campaign content is read-only; Restore before editing' USING ERRCODE='55000';
    END IF;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS campaign_lifecycle_guard ON public.email_campaign;
CREATE TRIGGER campaign_lifecycle_guard BEFORE INSERT OR UPDATE OR DELETE ON public.email_campaign
  FOR EACH ROW EXECUTE FUNCTION public.guard_campaign_lifecycle();

CREATE OR REPLACE FUNCTION public.guard_campaign_work()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE c public.email_campaign%rowtype;
BEGIN
  IF TG_OP='UPDATE' AND NEW.campaign_id IS DISTINCT FROM OLD.campaign_id THEN
    RAISE EXCEPTION 'Campaign work cannot be moved between campaigns' USING ERRCODE='55000';
  END IF;
  SELECT * INTO c FROM public.email_campaign WHERE id=NEW.campaign_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Campaign not found' USING ERRCODE='P0002'; END IF;
  IF TG_TABLE_NAME='email_campaign_recipient' THEN
    IF NEW.status IN ('pending','processing','sending') AND c.archived_at IS NOT NULL THEN
      RAISE EXCEPTION 'Archived campaign cannot claim recipients; Restore first' USING ERRCODE='55000';
    END IF;
    IF NEW.status IN ('processing','sending') AND
      (TG_OP='INSERT' OR NEW.status IS DISTINCT FROM OLD.status) AND c.status<>'sending' THEN
      RAISE EXCEPTION 'Campaign is not authorized to claim recipients' USING ERRCODE='55000';
    END IF;
  ELSIF c.archived_at IS NOT NULL THEN
    RAISE EXCEPTION 'Archived campaign cannot create delivery work; Restore first' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS campaign_recipient_lifecycle_guard ON public.email_campaign_recipient;
CREATE TRIGGER campaign_recipient_lifecycle_guard BEFORE INSERT OR UPDATE OF status,campaign_id
  ON public.email_campaign_recipient FOR EACH ROW EXECUTE FUNCTION public.guard_campaign_work();
DROP TRIGGER IF EXISTS campaign_preparation_lifecycle_guard ON public.campaign_preparation;
CREATE TRIGGER campaign_preparation_lifecycle_guard BEFORE INSERT OR UPDATE ON public.campaign_preparation
  FOR EACH ROW EXECUTE FUNCTION public.guard_campaign_work();
DROP TRIGGER IF EXISTS campaign_survey_lifecycle_guard ON public.campaign_survey_delivery;
CREATE TRIGGER campaign_survey_lifecycle_guard BEFORE INSERT ON public.campaign_survey_delivery
  FOR EACH ROW EXECUTE FUNCTION public.guard_campaign_work();

CREATE OR REPLACE FUNCTION public.campaign_lifecycle(p_campaign uuid,p_tenant uuid,p_action text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE c public.email_campaign%rowtype;
BEGIN
  IF p_action IS NULL OR p_action NOT IN ('archive','restore','delete') THEN
    RAISE EXCEPTION 'Invalid campaign lifecycle action' USING ERRCODE='22023'; END IF;
  SELECT * INTO c FROM public.email_campaign WHERE id=p_campaign AND tenant_id=p_tenant FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Campaign not found' USING ERRCODE='P0002'; END IF;
  PERFORM public.campaign_lifecycle_assert_idle(c.id);
  INSERT INTO public.campaign_lifecycle_permit VALUES(txid_current(),c.id);
  IF p_action='delete' THEN
    DELETE FROM public.email_campaign WHERE id=c.id;
  ELSE
    UPDATE public.email_campaign SET
      archived_at=CASE WHEN p_action='archive' THEN coalesce(archived_at,clock_timestamp()) ELSE NULL END,
      updated_at=clock_timestamp() WHERE id=c.id RETURNING * INTO c;
  END IF;
  DELETE FROM public.campaign_lifecycle_permit WHERE transaction_id=txid_current() AND campaign_id=c.id;
  IF p_action='delete' THEN RETURN jsonb_build_object('id',c.id,'deleted',true); END IF;
  RETURN to_jsonb(c);
END $$;

CREATE OR REPLACE FUNCTION public.campaign_test_send_begin(p_campaign uuid,p_tenant uuid)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE c public.email_campaign%rowtype; token uuid;
BEGIN
  SELECT * INTO c FROM public.email_campaign WHERE id=p_campaign AND tenant_id=p_tenant FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Campaign not found' USING ERRCODE='P0002'; END IF;
  IF c.archived_at IS NOT NULL THEN
    RAISE EXCEPTION 'Archived campaign cannot send tests; Restore first' USING ERRCODE='55000'; END IF;
  INSERT INTO public.campaign_test_send_lease(campaign_id,tenant_id) VALUES(c.id,c.tenant_id) RETURNING id INTO token;
  RETURN token;
END $$;
CREATE OR REPLACE FUNCTION public.campaign_test_send_end(p_campaign uuid,p_tenant uuid,p_lease uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
  PERFORM 1 FROM public.email_campaign WHERE id=p_campaign AND tenant_id=p_tenant FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Campaign not found' USING ERRCODE='P0002'; END IF;
  DELETE FROM public.campaign_test_send_lease WHERE id=p_lease AND campaign_id=p_campaign AND tenant_id=p_tenant;
  RETURN FOUND;
END $$;

CREATE OR REPLACE FUNCTION public.campaign_summary(p_tenant uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
  WITH campaigns AS (
    SELECT id,status FROM public.email_campaign WHERE tenant_id=p_tenant
  ), counts AS (
    SELECT count(*) FILTER(WHERE r.status IN ('sent','delivered','opened','clicked')) AS sent,
      count(*) FILTER(WHERE r.open_count>0) AS opened,
      count(*) FILTER(WHERE r.click_count>0) AS clicked
    FROM public.email_campaign_recipient r JOIN campaigns c ON c.id=r.campaign_id WHERE c.status='sent'
  )
  SELECT jsonb_build_object(
    'totalCampaigns',(SELECT count(*) FROM campaigns),
    'sentCampaigns',(SELECT count(*) FROM campaigns WHERE status='sent'),
    'draftCount',(SELECT count(*) FROM campaigns WHERE status='draft'),
    'scheduledCount',(SELECT count(*) FROM campaigns WHERE status='scheduled'),
    'totalSent',sent,'totalOpened',opened,'totalClicked',clicked,
    'avgOpenRate',CASE WHEN sent=0 THEN 0 ELSE round(100.0*opened/sent,1) END,
    'avgClickRate',CASE WHEN sent=0 THEN 0 ELSE round(100.0*clicked/sent,1) END) FROM counts
$$;
CREATE OR REPLACE FUNCTION public.campaign_lifecycle_ready()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$ SELECT true $$;

REVOKE ALL ON FUNCTION public.campaign_lifecycle_assert_idle(uuid),
  public.guard_campaign_lifecycle(),public.guard_campaign_work(),
  public.campaign_lifecycle(uuid,uuid,text),public.campaign_summary(uuid),
  public.campaign_test_send_begin(uuid,uuid),public.campaign_test_send_end(uuid,uuid,uuid),
  public.campaign_lifecycle_ready() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.campaign_lifecycle(uuid,uuid,text),
  public.campaign_test_send_begin(uuid,uuid),public.campaign_test_send_end(uuid,uuid,uuid),
  public.campaign_summary(uuid),public.campaign_lifecycle_ready() TO service_role;
NOTIFY pgrst,'reload schema';
COMMIT;
