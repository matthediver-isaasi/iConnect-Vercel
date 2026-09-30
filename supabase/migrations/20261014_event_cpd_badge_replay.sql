-- Auditable, service-only replay of saved CPD badge rules over historical events.
CREATE TABLE IF NOT EXISTS public.event_cpd_badge_replay (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES public.tenant(id) ON DELETE CASCADE,
  event_type text NOT NULL CHECK (event_type IN ('event','complex_event')),
  event_id uuid NOT NULL,
  requested_by text NOT NULL,
  rule_snapshot jsonb NOT NULL DEFAULT '[]'::jsonb,
  enqueued_count integer NOT NULL DEFAULT 0 CHECK (enqueued_count >= 0),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_event_cpd_badge_replay_event
  ON public.event_cpd_badge_replay(tenant_id,event_type,event_id,created_at DESC);

CREATE OR REPLACE FUNCTION public.enqueue_event_cpd_badge_replay(
  p_tenant_id uuid,p_event_type text,p_event_id uuid,p_replay_id uuid,p_actor text
) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_count integer:=0; v_added integer:=0; v_rules jsonb;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'service_role is required'; END IF;
  IF p_tenant_id IS NULL OR p_event_type NOT IN ('event','complex_event')
     OR p_event_id IS NULL OR p_replay_id IS NULL OR NULLIF(trim(p_actor),'') IS NULL THEN
    RAISE EXCEPTION 'complete replay scope and actor are required';
  END IF;
  SELECT enqueued_count INTO v_count FROM event_cpd_badge_replay
    WHERE id=p_replay_id AND tenant_id=p_tenant_id AND event_type=p_event_type AND event_id=p_event_id;
  IF FOUND THEN RETURN v_count; END IF;
  IF p_event_type='event' AND NOT EXISTS (
    SELECT 1 FROM event WHERE id=p_event_id AND tenant_id=p_tenant_id
  ) THEN RAISE EXCEPTION 'event does not belong to tenant';
  ELSIF p_event_type='complex_event' AND NOT EXISTS (
    SELECT 1 FROM complex_event WHERE id=p_event_id AND tenant_id=p_tenant_id
  ) THEN RAISE EXCEPTION 'complex event does not belong to tenant'; END IF;

  -- Share the configuration lock so the audit snapshot and queued work always
  -- describe one complete saved rule set.
  PERFORM pg_advisory_xact_lock(hashtextextended(
    p_tenant_id::text||':'||p_event_type||':'||p_event_id::text,0));
  SELECT COALESCE(jsonb_agg(to_jsonb(r) ORDER BY r.created_at,r.id),'[]'::jsonb)
    INTO v_rules FROM event_cpd_badge_rule r
    WHERE r.tenant_id=p_tenant_id AND r.event_type=p_event_type
      AND r.event_id=p_event_id AND r.active;
  INSERT INTO event_cpd_badge_replay(id,tenant_id,event_type,event_id,requested_by,rule_snapshot)
    VALUES(p_replay_id,p_tenant_id,p_event_type,p_event_id,p_actor,v_rules);

  -- With no award rule there is nothing useful to check. No-award overrides
  -- remain in the snapshot but never create work by themselves.
  IF NOT EXISTS (
    SELECT 1 FROM event_cpd_badge_rule r WHERE r.tenant_id=p_tenant_id
      AND r.event_type=p_event_type AND r.event_id=p_event_id AND r.active
      AND NOT r.is_no_award
  ) THEN RETURN 0; END IF;

  IF p_event_type='event' THEN
    INSERT INTO event_cpd_badge_outbox(
      tenant_id,idempotency_key,booking_type,booking_id,trigger_type,evidence_type,evidence_id
    )
    SELECT p_tenant_id,'badge-replay:'||p_replay_id||':registration:booking:'||b.id,
      'booking',b.id,'registration','confirmed_booking',b.id::text
    FROM booking b WHERE b.tenant_id=p_tenant_id AND b.event_id=p_event_id AND b.status='confirmed'
      AND EXISTS (SELECT 1 FROM event_cpd_badge_rule r WHERE r.tenant_id=p_tenant_id
        AND r.event_type=p_event_type AND r.event_id=p_event_id AND r.active
        AND r.trigger_type='registration' AND NOT r.is_no_award)
    ON CONFLICT(tenant_id,idempotency_key) DO NOTHING;
  ELSE
    INSERT INTO event_cpd_badge_outbox(
      tenant_id,idempotency_key,booking_type,booking_id,trigger_type,evidence_type,evidence_id
    )
    SELECT p_tenant_id,'badge-replay:'||p_replay_id||':registration:complex_event_booking:'||b.id,
      'complex_event_booking',b.id,'registration','confirmed_booking',b.id::text
    FROM complex_event_booking b WHERE b.tenant_id=p_tenant_id AND b.event_id=p_event_id AND b.status='confirmed'
      AND EXISTS (SELECT 1 FROM event_cpd_badge_rule r WHERE r.tenant_id=p_tenant_id
        AND r.event_type=p_event_type AND r.event_id=p_event_id AND r.active
        AND r.trigger_type='registration' AND NOT r.is_no_award)
    ON CONFLICT(tenant_id,idempotency_key) DO NOTHING;
  END IF;
  GET DIAGNOSTICS v_count=ROW_COUNT;

  IF EXISTS (SELECT 1 FROM event_cpd_badge_rule r WHERE r.tenant_id=p_tenant_id
    AND r.event_type=p_event_type AND r.event_id=p_event_id AND r.active
    AND r.trigger_type='attendance' AND NOT r.is_no_award) THEN
    IF p_event_type='event' THEN
      INSERT INTO event_cpd_badge_outbox(
        tenant_id,idempotency_key,booking_type,booking_id,trigger_type,evidence_type,evidence_id,evidence_snapshot
      )
      SELECT p_tenant_id,'badge-replay:'||p_replay_id||':attendance:qr:booking:'||b.id,
        'booking',b.id,'attendance','qr_checkin',b.id::text,
        jsonb_build_object('type','qr_checkin','checkedInAt',b.checked_in_at,
          'checkInReversedAt',b.check_in_reversed_at,'replayId',p_replay_id)
      FROM booking b WHERE b.tenant_id=p_tenant_id AND b.event_id=p_event_id
        AND b.status='confirmed' AND b.checked_in_at IS NOT NULL
        AND (b.check_in_reversed_at IS NULL OR b.checked_in_at>b.check_in_reversed_at)
      ON CONFLICT(tenant_id,idempotency_key) DO NOTHING;
    ELSE
      INSERT INTO event_cpd_badge_outbox(
        tenant_id,idempotency_key,booking_type,booking_id,trigger_type,evidence_type,evidence_id,evidence_snapshot
      )
      SELECT p_tenant_id,'badge-replay:'||p_replay_id||':attendance:qr:complex_event_booking:'||c.id,
        'complex_event_booking',b.id,'attendance','qr_checkin',c.id::text,
        jsonb_build_object('type','qr_checkin','checkedInAt',c.checked_in_at,
          'checkInReversedAt',c.check_in_reversed_at,'sessionId',c.session_id,'replayId',p_replay_id)
      FROM complex_event_session_checkin c
      JOIN complex_event_session s ON s.id=c.session_id AND s.tenant_id=c.tenant_id
        AND s.complex_event_id=c.complex_event_id
      JOIN complex_event_booking b ON b.id=c.booking_id AND b.tenant_id=c.tenant_id
        AND b.event_id=c.complex_event_id
      WHERE c.tenant_id=p_tenant_id AND c.complex_event_id=p_event_id
        AND b.status='confirmed' AND c.checked_in_at IS NOT NULL
        AND (c.check_in_reversed_at IS NULL OR c.checked_in_at>c.check_in_reversed_at)
      ON CONFLICT(tenant_id,idempotency_key) DO NOTHING;
    END IF;
    GET DIAGNOSTICS v_added=ROW_COUNT; v_count:=v_count+v_added;

    INSERT INTO event_cpd_badge_outbox(
      tenant_id,idempotency_key,booking_type,booking_id,trigger_type,evidence_type,evidence_id,evidence_snapshot
    )
    SELECT p_tenant_id,'badge-replay:'||p_replay_id||':attendance:'||o.provider||':'||
        o.booking_type||':'||o.booking_id||':'||o.attendance_target_id,
      o.booking_type,o.booking_id,'attendance',o.provider,o.outcome_revision_id::text,
      jsonb_build_object('type',o.provider,'finalized',true,'status',o.status,
        'revisionId',o.outcome_revision_id,'attendanceTargetId',o.attendance_target_id,
        'replayId',p_replay_id)
    FROM attendance_current_outcome o
    JOIN attendance_target t ON t.id=o.attendance_target_id AND t.tenant_id=o.tenant_id
    JOIN booking replay_booking ON p_event_type='event'
      AND replay_booking.id=o.booking_id AND replay_booking.tenant_id=o.tenant_id
      AND replay_booking.event_id=p_event_id AND replay_booking.status='confirmed'
    WHERE o.tenant_id=p_tenant_id AND t.event_id=p_event_id AND o.status='attended'
      AND o.provider IN ('zoom','teams')
      AND o.booking_type='booking'
    ON CONFLICT(tenant_id,idempotency_key) DO NOTHING;
    GET DIAGNOSTICS v_added=ROW_COUNT; v_count:=v_count+v_added;

    IF p_event_type='complex_event' THEN
      INSERT INTO event_cpd_badge_outbox(
        tenant_id,idempotency_key,booking_type,booking_id,trigger_type,evidence_type,evidence_id,evidence_snapshot
      )
      SELECT p_tenant_id,'badge-replay:'||p_replay_id||':attendance:'||o.provider||':'||
          o.booking_type||':'||o.booking_id||':'||o.attendance_target_id,
        o.booking_type,o.booking_id,'attendance',o.provider,o.outcome_revision_id::text,
        jsonb_build_object('type',o.provider,'finalized',true,'status',o.status,
          'revisionId',o.outcome_revision_id,'attendanceTargetId',o.attendance_target_id,
          'replayId',p_replay_id)
      FROM attendance_current_outcome o
      JOIN attendance_target t ON t.id=o.attendance_target_id AND t.tenant_id=o.tenant_id
      JOIN complex_event_booking replay_booking ON replay_booking.id=o.booking_id
        AND replay_booking.tenant_id=o.tenant_id AND replay_booking.event_id=p_event_id
        AND replay_booking.status='confirmed'
      WHERE o.tenant_id=p_tenant_id AND t.event_id=p_event_id AND o.status='attended'
        AND o.provider IN ('zoom','teams') AND o.booking_type='complex_event_booking'
      ON CONFLICT(tenant_id,idempotency_key) DO NOTHING;
      GET DIAGNOSTICS v_added=ROW_COUNT; v_count:=v_count+v_added;
    END IF;
  END IF;

  UPDATE event_cpd_badge_replay SET enqueued_count=v_count WHERE id=p_replay_id;
  RETURN v_count;
END $$;

ALTER TABLE public.event_cpd_badge_replay ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS service_role_all ON public.event_cpd_badge_replay;
CREATE POLICY service_role_all ON public.event_cpd_badge_replay
  FOR ALL TO service_role USING(true) WITH CHECK(true);
REVOKE ALL ON public.event_cpd_badge_replay FROM anon,authenticated;
REVOKE ALL ON FUNCTION public.enqueue_event_cpd_badge_replay(uuid,text,uuid,uuid,text)
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.enqueue_event_cpd_badge_replay(uuid,text,uuid,uuid,text)
  TO service_role;