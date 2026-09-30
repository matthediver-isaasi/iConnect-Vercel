-- Task #3768: transactionally publish immutable attendance outcome changes.
-- The transition and its outbox row are written in the same transaction as the
-- outcome revision, so a process failure can never lose a status change.

CREATE TABLE IF NOT EXISTS attendance_outcome_transition (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  outcome_revision_id uuid NOT NULL REFERENCES attendance_outcome_revision(id) ON DELETE CASCADE,
  attendance_target_id uuid NOT NULL REFERENCES attendance_target(id) ON DELETE CASCADE,
  event_id uuid,
  target_type text NOT NULL,
  target_id uuid NOT NULL,
  booking_type text NOT NULL,
  booking_id uuid NOT NULL,
  member_id uuid,
  ticket_id text,
  provider text NOT NULL,
  previous_status text,
  status text NOT NULL,
  duration_seconds integer NOT NULL,
  threshold_minutes integer NOT NULL,
  revision_number integer NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (outcome_revision_id)
);

CREATE TABLE IF NOT EXISTS attendance_transition_outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  transition_id uuid NOT NULL REFERENCES attendance_outcome_transition(id) ON DELETE CASCADE,
  payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','processing','retry','published','dead')),
  attempts integer NOT NULL DEFAULT 0,
  available_at timestamptz NOT NULL DEFAULT now(),
  locked_at timestamptz,
  lock_token uuid,
  published_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (transition_id)
);

CREATE INDEX IF NOT EXISTS idx_attendance_transition_booking
  ON attendance_outcome_transition(tenant_id, booking_type, booking_id, created_at);
CREATE INDEX IF NOT EXISTS idx_attendance_transition_outbox_ready
  ON attendance_transition_outbox(status, available_at, created_at)
  WHERE status IN ('pending','retry','processing');

-- A fingerprint may recur after an intervening correction (for example
-- attended -> absent -> attended). Only equality with the CURRENT revision is
-- an unchanged sync; history must allow the same result to appear again later.
DO $$
DECLARE
  v_constraint text;
BEGIN
  SELECT c.conname INTO v_constraint
  FROM pg_constraint c
  WHERE c.conrelid = 'attendance_outcome_revision'::regclass
    AND c.contype = 'u'
    AND pg_get_constraintdef(c.oid) ILIKE '%result_fingerprint%'
  LIMIT 1;
  IF v_constraint IS NOT NULL THEN
    EXECUTE format(
      'ALTER TABLE attendance_outcome_revision DROP CONSTRAINT %I',
      v_constraint
    );
  END IF;
END $$;

ALTER TABLE attendance_outcome_transition ENABLE ROW LEVEL SECURITY;
ALTER TABLE attendance_transition_outbox ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS service_role_all ON attendance_outcome_transition;
CREATE POLICY service_role_all ON attendance_outcome_transition
  FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS service_role_all ON attendance_transition_outbox;
CREATE POLICY service_role_all ON attendance_transition_outbox
  FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE OR REPLACE FUNCTION replace_attendance_report_snapshot(
  p_tenant_id uuid, p_provider text, p_idempotency_key text, p_snapshot jsonb
) RETURNS TABLE(target_id uuid, sync_run_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_target uuid; v_run uuid; v_existing_status text; v_policy uuid; v_item jsonb;
  v_revision uuid; v_number integer; v_type text; v_booking uuid; v_fingerprint text;
  v_current_fingerprint text;
  v_previous_status text; v_member uuid; v_ticket text; v_transition uuid; v_payload jsonb;
BEGIN
  IF p_tenant_id IS NULL OR p_provider IS NULL OR p_idempotency_key IS NULL
     OR p_snapshot->'target' IS NULL THEN RAISE EXCEPTION 'tenant, provider, idempotency key and target are required'; END IF;
  IF COALESCE(current_setting('request.jwt.claim.role', true), '') <> 'service_role'
     AND current_user <> 'service_role' THEN RAISE EXCEPTION 'service_role is required'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(p_tenant_id::text || ':' || p_provider || ':' ||
    (p_snapshot->'target'->>'id'), 0));
  v_policy := attendance_upsert_policy_snapshot(p_tenant_id, p_snapshot->'target'->'policy');
  INSERT INTO attendance_target (tenant_id,provider,target_type,target_id,event_id,provider_target_id,
      provider_target_type,policy_id,effective_threshold_minutes,tracking_enabled,scheduled_end_at,updated_at)
  VALUES (p_tenant_id,p_provider,p_snapshot->'target'->>'type',(p_snapshot->'target'->>'id')::uuid,
    NULLIF(p_snapshot->'target'->>'eventId','')::uuid,p_snapshot->'target'->>'providerTargetId',
    p_snapshot->'target'->>'providerTargetType',v_policy,
    COALESCE((p_snapshot->'target'->>'thresholdMinutes')::integer,1),true,
    NULLIF(p_snapshot->'target'->>'scheduledEndAt','')::timestamptz,now())
  ON CONFLICT (tenant_id,provider,target_type,target_id) DO UPDATE SET
    event_id=EXCLUDED.event_id,provider_target_id=EXCLUDED.provider_target_id,
    provider_target_type=EXCLUDED.provider_target_type,policy_id=EXCLUDED.policy_id,
    effective_threshold_minutes=EXCLUDED.effective_threshold_minutes,
    scheduled_end_at=EXCLUDED.scheduled_end_at,updated_at=now()
  RETURNING id INTO v_target;
  SELECT id,status INTO v_run,v_existing_status FROM attendance_sync_run
    WHERE tenant_id=p_tenant_id AND provider=p_provider AND attendance_target_id=v_target
      AND idempotency_key=p_idempotency_key FOR UPDATE;
  IF FOUND AND v_existing_status='succeeded' THEN
    target_id := v_target; sync_run_id := v_run; RETURN NEXT; RETURN;
  END IF;
  IF NOT FOUND THEN
    INSERT INTO attendance_sync_run (tenant_id,provider,attendance_target_id,idempotency_key,status,metadata)
    VALUES (p_tenant_id,p_provider,v_target,p_idempotency_key,'running',
      COALESCE(p_snapshot->'metadata','{}'::jsonb)) RETURNING id INTO v_run;
  ELSE
    UPDATE attendance_sync_run SET status='running',attempted_at=now(),completed_at=NULL,
      provider_report_available=false,error_code=NULL,error_message=NULL,
      metadata=COALESCE(p_snapshot->'metadata','{}'::jsonb) WHERE id=v_run;
  END IF;
  DELETE FROM attendance_participant_interval WHERE tenant_id=p_tenant_id AND provider=p_provider AND attendance_target_id=v_target;
  DELETE FROM attendance_participant_match WHERE tenant_id=p_tenant_id AND provider=p_provider AND attendance_target_id=v_target;
  FOR v_item IN SELECT value FROM jsonb_array_elements(COALESCE(p_snapshot->'intervals','[]'::jsonb)) LOOP
    INSERT INTO attendance_participant_interval (tenant_id,provider,attendance_target_id,participant_key,interval_key,
      participant_email,participant_name,joined_at,left_at,duration_seconds,provider_participant_id,source_metadata,sync_run_id)
    VALUES (p_tenant_id,p_provider,v_target,v_item->>'participantKey',v_item->>'intervalKey',
      NULLIF(v_item->>'email',''),NULLIF(v_item->>'name',''),NULLIF(v_item->>'joinedAt','')::timestamptz,
      NULLIF(v_item->>'leftAt','')::timestamptz,COALESCE((v_item->>'durationSeconds')::integer,0),
      NULLIF(v_item->>'providerParticipantId',''),COALESCE(v_item->'metadata','{}'::jsonb),v_run);
  END LOOP;
  FOR v_item IN SELECT value FROM jsonb_array_elements(COALESCE(p_snapshot->'matches','[]'::jsonb)) LOOP
    INSERT INTO attendance_participant_match (tenant_id,provider,attendance_target_id,participant_key,booking_type,
      booking_id,member_id,match_status,matched_by,sync_run_id)
    VALUES (p_tenant_id,p_provider,v_target,v_item->>'participantKey',NULLIF(v_item->>'bookingType',''),
      NULLIF(v_item->>'bookingId','')::uuid,NULLIF(v_item->>'memberId','')::uuid,
      v_item->>'matchStatus',NULLIF(v_item->>'matchedBy',''),v_run);
  END LOOP;
  DELETE FROM attendance_current_outcome current_outcome
  WHERE current_outcome.tenant_id=p_tenant_id
    AND current_outcome.provider=p_provider
    AND current_outcome.attendance_target_id=v_target
    AND NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements(COALESCE(p_snapshot->'outcomes','[]'::jsonb)) outcome
      WHERE outcome->>'bookingType'=current_outcome.booking_type
        AND (outcome->>'bookingId')::uuid=current_outcome.booking_id
    );
  FOR v_item IN SELECT value FROM jsonb_array_elements(COALESCE(p_snapshot->'outcomes','[]'::jsonb)) LOOP
    v_type := v_item->>'bookingType';
    v_booking := (v_item->>'bookingId')::uuid;
    v_fingerprint := v_item->>'resultFingerprint';
    v_member := NULLIF(v_item->>'memberId','')::uuid;
    v_ticket := NULLIF(v_item->>'ticketId','');
    v_revision := NULL;
    v_previous_status := NULL;
    v_current_fingerprint := NULL;
    SELECT c.status, c.outcome_revision_id, r.result_fingerprint
      INTO v_previous_status, v_revision, v_current_fingerprint
    FROM attendance_current_outcome c
    JOIN attendance_outcome_revision r ON r.id=c.outcome_revision_id
    WHERE c.tenant_id=p_tenant_id AND c.provider=p_provider
      AND c.attendance_target_id=v_target AND c.booking_type=v_type AND c.booking_id=v_booking;
    IF v_current_fingerprint IS DISTINCT FROM v_fingerprint THEN
      SELECT COALESCE(max(r.revision_number),0)+1 INTO v_number FROM attendance_outcome_revision r
        WHERE r.tenant_id=p_tenant_id AND r.provider=p_provider
          AND r.attendance_target_id=v_target AND r.booking_type=v_type AND r.booking_id=v_booking;
      INSERT INTO attendance_outcome_revision (tenant_id,provider,attendance_target_id,booking_type,booking_id,revision_number,
        status,duration_seconds,threshold_minutes,sync_run_id,result_fingerprint)
      VALUES (p_tenant_id,p_provider,v_target,v_type,v_booking,v_number,v_item->>'status',
        COALESCE((v_item->>'durationSeconds')::integer,0),COALESCE((v_item->>'thresholdMinutes')::integer,1),v_run,v_fingerprint)
      RETURNING id INTO v_revision;

      v_transition := gen_random_uuid();
      v_payload := jsonb_build_object(
        'eventType','attendance.outcome.transition',
        'transitionId',v_transition,
        'event',jsonb_build_object('id',NULLIF(p_snapshot->'target'->>'eventId','')),
        'target',jsonb_build_object(
          'type',p_snapshot->'target'->>'type',
          'id',p_snapshot->'target'->>'id',
          'attendance_target_id',v_target,
          'provider_target_id',p_snapshot->'target'->>'providerTargetId',
          'provider_target_type',p_snapshot->'target'->>'providerTargetType'
        ),
        'attendanceTargetId',v_target,
        'booking',jsonb_build_object('type',v_type,'id',v_booking),
        'member',jsonb_build_object('id',v_member),
        'ticket',jsonb_build_object('id',v_ticket),
        'provider',p_provider,
        'durationSeconds',COALESCE((v_item->>'durationSeconds')::integer,0),
        'thresholdMinutes',COALESCE((v_item->>'thresholdMinutes')::integer,1),
        'status',v_item->>'status',
        'previousStatus',v_previous_status,
        'revision',v_number,
        'revisionId',v_revision
      );
      INSERT INTO attendance_outcome_transition
        (id,tenant_id,outcome_revision_id,attendance_target_id,event_id,target_type,target_id,
         booking_type,booking_id,member_id,ticket_id,provider,previous_status,status,
         duration_seconds,threshold_minutes,revision_number,payload)
      VALUES
        (v_transition,p_tenant_id,v_revision,v_target,NULLIF(p_snapshot->'target'->>'eventId','')::uuid,
         p_snapshot->'target'->>'type',(p_snapshot->'target'->>'id')::uuid,v_type,v_booking,
         v_member,v_ticket,p_provider,v_previous_status,v_item->>'status',
         COALESCE((v_item->>'durationSeconds')::integer,0),
         COALESCE((v_item->>'thresholdMinutes')::integer,1),v_number,v_payload);
      INSERT INTO attendance_transition_outbox(tenant_id,transition_id,payload)
        VALUES (p_tenant_id,v_transition,v_payload);
    END IF;
    INSERT INTO attendance_current_outcome (tenant_id,provider,attendance_target_id,booking_type,booking_id,
      outcome_revision_id,status,duration_seconds,threshold_minutes,updated_at)
    VALUES (p_tenant_id,p_provider,v_target,v_type,v_booking,v_revision,v_item->>'status',
      COALESCE((v_item->>'durationSeconds')::integer,0),COALESCE((v_item->>'thresholdMinutes')::integer,1),now())
    ON CONFLICT (tenant_id,provider,attendance_target_id,booking_type,booking_id) DO UPDATE SET
      outcome_revision_id=EXCLUDED.outcome_revision_id,status=EXCLUDED.status,
      duration_seconds=EXCLUDED.duration_seconds,threshold_minutes=EXCLUDED.threshold_minutes,updated_at=now();
  END LOOP;
  UPDATE attendance_sync_run SET status='succeeded',completed_at=now(),provider_report_available=true,
    participant_count=jsonb_array_length(COALESCE(p_snapshot->'intervals','[]'::jsonb)) WHERE id=v_run AND tenant_id=p_tenant_id;
  target_id := v_target; sync_run_id := v_run; RETURN NEXT;
END $$;

CREATE OR REPLACE FUNCTION claim_attendance_transition_outbox(p_limit integer DEFAULT 25)
RETURNS TABLE(id uuid, tenant_id uuid, transition_id uuid, payload jsonb, lock_token uuid, attempts integer)
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  WITH candidates AS (
    SELECT o.id
    FROM attendance_transition_outbox o
    WHERE (
      (o.status IN ('pending','retry') AND o.available_at <= now())
      OR (o.status='processing' AND o.locked_at < now() - interval '10 minutes')
    )
    ORDER BY o.created_at
    FOR UPDATE SKIP LOCKED
    LIMIT LEAST(GREATEST(p_limit, 1), 100)
  ), claimed AS (
    UPDATE attendance_transition_outbox o
    SET status='processing', attempts=o.attempts+1, locked_at=now(),
        lock_token=gen_random_uuid(), updated_at=now()
    FROM candidates c WHERE o.id=c.id
    RETURNING o.id,o.tenant_id,o.transition_id,o.payload,o.lock_token,o.attempts
  )
  SELECT * FROM claimed;
$$;

CREATE OR REPLACE FUNCTION complete_attendance_transition_outbox(p_id uuid, p_lock_token uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  UPDATE attendance_transition_outbox SET status='published',published_at=now(),
    locked_at=NULL,lock_token=NULL,last_error=NULL,updated_at=now()
  WHERE id=p_id AND status='processing' AND lock_token=p_lock_token;
  RETURN FOUND;
END $$;

CREATE OR REPLACE FUNCTION fail_attendance_transition_outbox(
  p_id uuid, p_lock_token uuid, p_error text, p_max_attempts integer DEFAULT 8
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  UPDATE attendance_transition_outbox
  SET status=CASE WHEN attempts >= p_max_attempts THEN 'dead' ELSE 'retry' END,
      available_at=now() + make_interval(secs => LEAST(3600, (power(2, LEAST(attempts,10)) * 15)::integer)),
      locked_at=NULL,lock_token=NULL,last_error=left(p_error,2000),updated_at=now()
  WHERE id=p_id AND status='processing' AND lock_token=p_lock_token;
  RETURN FOUND;
END $$;

-- Resolve an ambiguous workflow attempt without replaying it. A tenant admin
-- explicitly acknowledges that the claimed workflow must be skipped; the
-- outbox is then re-queued so any still-unclaimed workflows can continue.
CREATE OR REPLACE FUNCTION acknowledge_attendance_workflow_delivery(
  p_tenant_id uuid,
  p_transition_id uuid,
  p_workflow_id uuid,
  p_note text DEFAULT NULL,
  p_actor text DEFAULT NULL
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_outbox_id uuid;
  v_outbox_status text;
  v_booking_id uuid;
  v_trigger_mode text;
  v_transition_key text;
  v_once_key text;
  v_claim_updated boolean := false;
BEGIN
  SELECT o.id, o.status, t.booking_id, w.trigger_mode
    INTO v_outbox_id, v_outbox_status, v_booking_id, v_trigger_mode
  FROM attendance_transition_outbox o
  JOIN attendance_outcome_transition t
    ON t.id=o.transition_id AND t.tenant_id=o.tenant_id
  JOIN workflow w
    ON w.id=p_workflow_id AND w.tenant_id=o.tenant_id
      AND w.trigger_type='event_attendance_result'
  WHERE o.tenant_id=p_tenant_id AND o.transition_id=p_transition_id
    AND o.status IN ('retry','dead')
  FOR UPDATE OF o;

  IF v_outbox_id IS NULL THEN RETURN false; END IF;

  v_transition_key := 'attendance-result:' || p_transition_id::text
    || ':workflow:' || p_workflow_id::text;
  v_once_key := 'attendance-once:' || p_tenant_id::text || ':'
    || p_workflow_id::text || ':' || v_booking_id::text;

  UPDATE workflow_delivery_claim
  SET status='completed',
      completed_at=COALESCE(completed_at,now()),
      last_error='Tenant admin acknowledged without replay'
        || CASE WHEN NULLIF(trim(p_note),'') IS NULL THEN '' ELSE ': ' || left(trim(p_note),500) END,
      updated_at=now()
  WHERE tenant_id=p_tenant_id
    AND delivery_key IN (v_transition_key,v_once_key)
    AND status IN ('processing','failed');
  v_claim_updated := FOUND;
  IF NOT v_claim_updated THEN RETURN false; END IF;

  UPDATE attendance_transition_outbox
  SET status='pending', attempts=0, available_at=now(), locked_at=NULL,
      lock_token=NULL, last_error=NULL, updated_at=now()
  WHERE id=v_outbox_id AND status IN ('retry','dead');
  IF NOT FOUND THEN
    RAISE EXCEPTION 'attendance transition recovery state changed' USING ERRCODE='40001';
  END IF;

  INSERT INTO workflow_log(
    tenant_id,workflow_id,entity_type,entity_id,trigger_data,
    actions_executed,status,error_message
  ) VALUES (
    p_tenant_id,p_workflow_id,'member',v_booking_id,
    jsonb_build_object(
      'trigger_type','event_attendance_result',
      'attendance_transition_id',p_transition_id,
      'booking_id',v_booking_id,
      'reason','operator_acknowledged_without_replay',
      'acknowledged_by',p_actor
    ),
    jsonb_build_array(jsonb_build_object(
      'action_type','attendance_delivery_recovery',
      'status','skipped',
      'message','The ambiguous prior attempt was acknowledged and will not be replayed.'
    )),
    'partial',
    NULLIF(left(trim(p_note),500),'')
  );
  RETURN true;
END $$;

REVOKE ALL ON FUNCTION replace_attendance_report_snapshot(uuid,text,text,jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION claim_attendance_transition_outbox(integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION complete_attendance_transition_outbox(uuid,uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION fail_attendance_transition_outbox(uuid,uuid,text,integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION acknowledge_attendance_workflow_delivery(uuid,uuid,uuid,text,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION replace_attendance_report_snapshot(uuid,text,text,jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION claim_attendance_transition_outbox(integer) TO service_role;
GRANT EXECUTE ON FUNCTION complete_attendance_transition_outbox(uuid,uuid) TO service_role;
GRANT EXECUTE ON FUNCTION fail_attendance_transition_outbox(uuid,uuid,text,integer) TO service_role;
GRANT EXECUTE ON FUNCTION acknowledge_attendance_workflow_delivery(uuid,uuid,uuid,text,text) TO service_role;