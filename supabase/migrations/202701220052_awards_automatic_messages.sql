BEGIN;
ALTER TABLE public.awards_message_configuration
  ADD COLUMN automatic boolean NOT NULL DEFAULT false,
  ADD COLUMN offset_minutes integer NOT NULL DEFAULT 1440 CHECK(offset_minutes BETWEEN 0 AND 525600),
  ADD COLUMN automatic_since timestamptz,
  ADD COLUMN last_scan_at timestamptz;
CREATE FUNCTION public.awards_configure_automatic_messages(p_tenant uuid,p_award uuid,p_category text,p_version bigint,
  p_automatic boolean,p_offset integer,p_actor_kind text,p_actor uuid,p_reason text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE c public.awards_message_configuration;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'Service authority required' USING ERRCODE='42501'; END IF;
  IF p_actor_kind NOT IN ('member','tenant_user') OR p_actor IS NULL OR p_automatic IS NULL OR p_offset IS NULL OR p_offset NOT BETWEEN 0 AND 525600
    OR length(btrim(coalesce(p_reason,'')))=0 OR p_category NOT IN ('application_confirmation','application_deadline',
      'judge_invitation_reminder','judging_deadline','incomplete_assessment','moderation_invitation') THEN
    RAISE EXCEPTION 'Supported automatic category, timing and reason required'; END IF;
  PERFORM 1 FROM public.awards_competition WHERE tenant_id=p_tenant AND id=p_award FOR UPDATE;
  SELECT * INTO c FROM public.awards_message_configuration WHERE tenant_id=p_tenant AND award_id=p_award AND category=p_category FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Save message configuration before enabling automation'; END IF;
  IF c.version IS DISTINCT FROM p_version THEN RAISE EXCEPTION 'Message configuration changed' USING ERRCODE='40001'; END IF;
  UPDATE public.awards_message_configuration SET automatic=p_automatic,offset_minutes=p_offset,
    automatic_since=CASE WHEN p_automatic AND NOT automatic THEN clock_timestamp() ELSE automatic_since END,
    version=version+1,last_scan_at=NULL WHERE id=c.id RETURNING * INTO c;
  INSERT INTO public.awards_audit_event(tenant_id,award_id,actor_kind,actor_id,action,subject_id,reason,changes)
    VALUES(p_tenant,p_award,p_actor_kind,p_actor,'message.automation_configured',c.id,p_reason,
      jsonb_build_object('automatic',p_automatic,'offset_minutes',p_offset,'new_records_since',c.automatic_since));
  RETURN to_jsonb(c);
END $$;
CREATE FUNCTION public.awards_schedule_automatic_messages(p_limit integer DEFAULT 5)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE c public.awards_message_configuration; candidate record; scanned integer:=0; queued integer:=0; request uuid; delivery_context jsonb; due timestamptz;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'Service authority required' USING ERRCODE='42501'; END IF;
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 10 THEN RAISE EXCEPTION 'Invalid scheduler limit'; END IF;
  FOR iteration IN 1..p_limit LOOP
    -- Lock the award first, like configuration/queue commands. SKIP LOCKED
    -- prevents overlapping cron invocations waiting on each other's awards.
    SELECT config.* INTO c FROM public.awards_message_configuration config JOIN public.awards_competition w ON w.id=config.award_id
      WHERE config.automatic AND config.enabled AND config.automatic_since IS NOT NULL
        AND w.state NOT IN ('completed','archived') AND (config.last_scan_at IS NULL OR config.last_scan_at<clock_timestamp()-interval '30 seconds')
      ORDER BY config.last_scan_at NULLS FIRST,config.id LIMIT 1 FOR UPDATE OF w SKIP LOCKED;
    EXIT WHEN NOT FOUND;
    SELECT * INTO c FROM public.awards_message_configuration WHERE id=c.id FOR UPDATE;
    UPDATE public.awards_message_configuration SET last_scan_at=clock_timestamp() WHERE id=c.id;
    scanned:=scanned+1;
    FOR candidate IN
      WITH targets AS (
        SELECT a.id subject,a.created_at received,w.closes_at deadline,NULL::bigint generation,NULL::bigint round_version,
          jsonb_build_object('application_id',a.id) context
        FROM public.awards_application a JOIN public.awards_competition w ON w.id=a.award_id
        WHERE a.tenant_id=c.tenant_id AND a.award_id=c.award_id AND a.created_at>=c.automatic_since
          AND c.category IN ('application_confirmation','application_deadline') AND a.eligibility<>'withdrawn'
        UNION ALL
        SELECT j.id,j.created_at,
          CASE WHEN c.category='judge_invitation_reminder' THEN coalesce(invite.expires_at,j.expires_at,r.closes_at) ELSE r.closes_at END,
          j.credential_generation,r.version,jsonb_build_object('appointment_id',j.id,'generation',j.credential_generation)
        FROM public.assessment_appointment j JOIN public.assessment_round r ON r.id=j.round_id
        LEFT JOIN LATERAL(SELECT i.expires_at FROM public.assessment_invitation i WHERE i.appointment_id=j.id
          AND i.generation=j.credential_generation AND i.revoked_at IS NULL ORDER BY i.created_at DESC LIMIT 1) invite ON true
        WHERE j.tenant_id=c.tenant_id AND r.award_id=c.award_id AND j.created_at>=c.automatic_since
          AND c.category IN ('judge_invitation_reminder','judging_deadline','incomplete_assessment','moderation_invitation')
          AND (c.category<>'moderation_invitation' OR r.state='moderation')
      ), prepared AS (
        SELECT *,md5(c.id::text||':'||subject::text||':'||
          CASE WHEN c.category='application_confirmation' THEN 'received'
            WHEN c.category='moderation_invitation' THEN 'round:'||round_version::text
            ELSE coalesce(deadline::text,'none')||':'||coalesce(generation::text,'') END)::uuid request_id,
          CASE WHEN c.category IN ('application_confirmation','moderation_invitation') THEN received
            ELSE deadline-make_interval(mins=>c.offset_minutes) END due_at FROM targets
      )
      SELECT * FROM prepared WHERE due_at IS NOT NULL
        AND NOT EXISTS(SELECT 1 FROM public.awards_delivery d WHERE d.tenant_id=c.tenant_id AND d.deduplication_key='message:'||prepared.request_id::text)
        AND public.awards_message_authority(c.tenant_id,c.award_id,c.category,context,NULL)
      ORDER BY due_at,subject LIMIT 100
    LOOP
      request:=candidate.request_id;delivery_context:=candidate.context;due:=candidate.due_at;
      IF c.category NOT IN ('application_confirmation','moderation_invitation') THEN
        delivery_context:=delivery_context||jsonb_build_object('automatic_deadline',candidate.deadline);
      ELSIF c.category='moderation_invitation' THEN
        delivery_context:=delivery_context||jsonb_build_object('automatic_round_version',candidate.round_version);
      END IF;
      PERFORM public.awards_queue_message(c.tenant_id,c.award_id,c.category,delivery_context,NULL,due,request,'system',NULL,'Configured automatic message');
      queued:=queued+1;
    END LOOP;
  END LOOP;
  RETURN jsonb_build_object('configurationsScanned',scanned,'queued',queued);
END $$;
REVOKE ALL ON FUNCTION public.awards_configure_automatic_messages(uuid,uuid,text,bigint,boolean,integer,text,uuid,text) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.awards_schedule_automatic_messages(integer) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.awards_configure_automatic_messages(uuid,uuid,text,bigint,boolean,integer,text,uuid,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.awards_schedule_automatic_messages(integer) TO service_role;
COMMIT;
