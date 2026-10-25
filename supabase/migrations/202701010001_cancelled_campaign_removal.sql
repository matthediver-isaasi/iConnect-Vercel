-- Forward-only; apply to verified DEST only after separate approval.
BEGIN;
CREATE OR REPLACE FUNCTION public.campaign_lifecycle_assert_idle(p_campaign uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE campaign_status text;
BEGIN
  SELECT status INTO campaign_status FROM public.email_campaign WHERE id=p_campaign;
  IF EXISTS(SELECT 1 FROM public.campaign_test_send_lease WHERE campaign_id=p_campaign) THEN
    RAISE EXCEPTION 'Campaign has unresolved test-send work; an operator must reconcile provider delivery and release the test-send lease before lifecycle changes'
      USING ERRCODE='55000';
  END IF;
  IF campaign_status IN ('scheduled','preparing','sending','paused') THEN
    RAISE EXCEPTION 'Campaign has active or unresolved delivery work; stop scheduling/sending and reconcile delivery before lifecycle changes' USING ERRCODE='55000';
  END IF;
  IF EXISTS(SELECT 1 FROM public.email_campaign_recipient WHERE campaign_id=p_campaign
    AND (status IN ('processing','sending') OR
      (status='pending' AND (campaign_status IS DISTINCT FROM 'cancelled'
        OR sent_at IS NOT NULL OR mailgun_message_id IS NOT NULL)))) THEN
    RAISE EXCEPTION 'Campaign has unresolved recipient delivery; an operator must reconcile queued or processing/provider work before removal. Cancellation does not resolve delivery already in progress.'
      USING ERRCODE='55000';
  END IF;
  IF EXISTS(SELECT 1 FROM public.campaign_preparation WHERE campaign_id=p_campaign
    AND (phase NOT IN ('complete','failed') OR lease_until>clock_timestamp())) THEN
    RAISE EXCEPTION 'Campaign has unresolved preparation work or an active preparation lease; removal is blocked' USING ERRCODE='55000';
  END IF;
  IF EXISTS(SELECT 1 FROM public.campaign_survey_delivery WHERE campaign_id=p_campaign AND status='pending') THEN
    RAISE EXCEPTION 'Campaign has unresolved survey delivery; an operator must reconcile it before removal' USING ERRCODE='55000';
  END IF;
END $$;

-- Advisory read only: lifecycle RPC and delete trigger repeat the same guard
-- under the parent lock. Never interpret combined pending_count as idle.
CREATE OR REPLACE FUNCTION public.campaign_removal_eligibility(p_campaign uuid,p_tenant uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE reason text; delete_reason text; queued bigint; processing bigint;
BEGIN
  IF NOT EXISTS(SELECT 1 FROM public.email_campaign WHERE id=p_campaign AND tenant_id=p_tenant) THEN
    RAISE EXCEPTION 'Campaign not found' USING ERRCODE='P0002';
  END IF;
  SELECT count(*) FILTER(WHERE status='pending'),
    count(*) FILTER(WHERE status IN ('processing','sending'))
    INTO queued,processing FROM public.email_campaign_recipient WHERE campaign_id=p_campaign;
  BEGIN
    PERFORM public.campaign_lifecycle_assert_idle(p_campaign);
  EXCEPTION WHEN SQLSTATE '55000' THEN reason:=SQLERRM;
  END;
  delete_reason:=reason;
  IF delete_reason IS NULL AND EXISTS(SELECT 1 FROM public.campaign_survey_delivery WHERE campaign_id=p_campaign) THEN
    delete_reason:='Campaign has protected survey provenance; use Archive instead';
  END IF;
  RETURN jsonb_build_object('queued',queued,'processing',processing,
    'archiveAllowed',reason IS NULL,'deleteAllowed',delete_reason IS NULL,
    'archiveReason',reason,'deleteReason',delete_reason);
END $$;
REVOKE ALL ON FUNCTION public.campaign_lifecycle_assert_idle(uuid),
  public.campaign_removal_eligibility(uuid,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.campaign_removal_eligibility(uuid,uuid) TO service_role;
NOTIFY pgrst,'reload schema';
COMMIT;
