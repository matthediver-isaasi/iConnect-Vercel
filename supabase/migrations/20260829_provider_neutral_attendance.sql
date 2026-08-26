-- Task #3766: durable, provider-neutral online attendance.
-- Idempotent and intentionally keeps zoom_attendance as a compatibility ledger.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS zoom_attendance (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  event_id uuid,
  complex_event_session_id uuid,
  zoom_meeting_id text NOT NULL,
  zoom_type text NOT NULL DEFAULT 'meeting',
  participant_email text,
  participant_name text,
  join_time timestamptz,
  leave_time timestamptz,
  duration_minutes integer DEFAULT 0,
  matched_booking_id uuid,
  matched_member_id uuid,
  synced_at timestamptz DEFAULT now(),
  created_at timestamptz DEFAULT now()
);

ALTER TABLE event ADD COLUMN IF NOT EXISTS attendance_tracking_enabled boolean NOT NULL DEFAULT false;
ALTER TABLE event ADD COLUMN IF NOT EXISTS attendance_provider text;
ALTER TABLE event ADD COLUMN IF NOT EXISTS attendance_threshold_minutes integer NOT NULL DEFAULT 1;
ALTER TABLE complex_event ADD COLUMN IF NOT EXISTS attendance_tracking_enabled boolean NOT NULL DEFAULT false;
ALTER TABLE complex_event ADD COLUMN IF NOT EXISTS attendance_provider text;
ALTER TABLE complex_event ADD COLUMN IF NOT EXISTS attendance_threshold_minutes integer NOT NULL DEFAULT 1;
ALTER TABLE complex_event_session ADD COLUMN IF NOT EXISTS attendance_policy_override boolean NOT NULL DEFAULT false;
ALTER TABLE complex_event_session ADD COLUMN IF NOT EXISTS attendance_tracking_enabled boolean;
ALTER TABLE complex_event_session ADD COLUMN IF NOT EXISTS attendance_provider text;
ALTER TABLE complex_event_session ADD COLUMN IF NOT EXISTS attendance_threshold_minutes integer;
ALTER TABLE event_agenda_item ADD COLUMN IF NOT EXISTS attendance_policy_override boolean NOT NULL DEFAULT false;
ALTER TABLE event_agenda_item ADD COLUMN IF NOT EXISTS attendance_tracking_enabled boolean;
ALTER TABLE event_agenda_item ADD COLUMN IF NOT EXISTS attendance_provider text;
ALTER TABLE event_agenda_item ADD COLUMN IF NOT EXISTS attendance_threshold_minutes integer;

CREATE TABLE IF NOT EXISTS attendance_policy (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  owner_type text NOT NULL CHECK (owner_type IN ('event','complex_event','complex_event_session','agenda_item')),
  owner_id uuid NOT NULL,
  enabled boolean NOT NULL DEFAULT false,
  provider text,
  threshold_minutes integer NOT NULL DEFAULT 1 CHECK (threshold_minutes >= 0),
  inherits_from_policy_id uuid REFERENCES attendance_policy(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, owner_type, owner_id)
);

CREATE TABLE IF NOT EXISTS attendance_target (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  provider text NOT NULL,
  target_type text NOT NULL CHECK (target_type IN ('event','complex_event_session','agenda_item')),
  target_id uuid NOT NULL,
  event_id uuid,
  provider_target_id text NOT NULL,
  provider_target_type text NOT NULL,
  policy_id uuid REFERENCES attendance_policy(id) ON DELETE SET NULL,
  effective_threshold_minutes integer NOT NULL DEFAULT 1 CHECK (effective_threshold_minutes >= 0),
  tracking_enabled boolean NOT NULL DEFAULT true,
  scheduled_end_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, provider, target_type, target_id),
  UNIQUE (tenant_id, provider, provider_target_type, provider_target_id, target_type, target_id)
);

CREATE TABLE IF NOT EXISTS attendance_sync_run (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  provider text NOT NULL,
  attendance_target_id uuid NOT NULL REFERENCES attendance_target(id) ON DELETE CASCADE,
  idempotency_key text NOT NULL,
  status text NOT NULL CHECK (status IN ('running','pending','succeeded','error')),
  attempted_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  provider_report_available boolean NOT NULL DEFAULT false,
  participant_count integer NOT NULL DEFAULT 0,
  error_code text,
  error_message text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (tenant_id, provider, attendance_target_id, idempotency_key)
);

CREATE TABLE IF NOT EXISTS attendance_participant_interval (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  provider text NOT NULL,
  attendance_target_id uuid NOT NULL REFERENCES attendance_target(id) ON DELETE CASCADE,
  participant_key text NOT NULL,
  interval_key text NOT NULL,
  participant_email text,
  participant_name text,
  joined_at timestamptz,
  left_at timestamptz,
  duration_seconds integer NOT NULL DEFAULT 0 CHECK (duration_seconds >= 0),
  provider_participant_id text,
  source_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  sync_run_id uuid REFERENCES attendance_sync_run(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, provider, attendance_target_id, participant_key, interval_key)
);

CREATE TABLE IF NOT EXISTS attendance_participant_match (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  provider text NOT NULL,
  attendance_target_id uuid NOT NULL REFERENCES attendance_target(id) ON DELETE CASCADE,
  participant_key text NOT NULL,
  booking_type text,
  booking_id uuid,
  member_id uuid,
  match_status text NOT NULL CHECK (match_status IN ('matched','unmatched','ambiguous')),
  matched_by text,
  sync_run_id uuid REFERENCES attendance_sync_run(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, provider, attendance_target_id, participant_key)
);

CREATE TABLE IF NOT EXISTS attendance_outcome_revision (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  provider text NOT NULL,
  attendance_target_id uuid NOT NULL REFERENCES attendance_target(id) ON DELETE CASCADE,
  booking_type text NOT NULL,
  booking_id uuid NOT NULL,
  revision_number integer NOT NULL,
  status text NOT NULL CHECK (status IN ('pending','error','attended','below_threshold','absent','unmatched')),
  duration_seconds integer NOT NULL DEFAULT 0,
  threshold_minutes integer NOT NULL,
  sync_run_id uuid REFERENCES attendance_sync_run(id) ON DELETE SET NULL,
  result_fingerprint text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, provider, attendance_target_id, booking_type, booking_id, revision_number),
  UNIQUE (tenant_id, provider, attendance_target_id, booking_type, booking_id, result_fingerprint)
);

CREATE TABLE IF NOT EXISTS attendance_current_outcome (
  tenant_id uuid NOT NULL,
  provider text NOT NULL,
  attendance_target_id uuid NOT NULL REFERENCES attendance_target(id) ON DELETE CASCADE,
  booking_type text NOT NULL,
  booking_id uuid NOT NULL,
  outcome_revision_id uuid NOT NULL REFERENCES attendance_outcome_revision(id) ON DELETE CASCADE,
  status text NOT NULL,
  duration_seconds integer NOT NULL DEFAULT 0,
  threshold_minutes integer NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, provider, attendance_target_id, booking_type, booking_id)
);

CREATE INDEX IF NOT EXISTS idx_attendance_target_event ON attendance_target(tenant_id, event_id);
CREATE INDEX IF NOT EXISTS idx_attendance_interval_target ON attendance_participant_interval(tenant_id, attendance_target_id);
CREATE INDEX IF NOT EXISTS idx_attendance_match_booking ON attendance_participant_match(tenant_id, booking_type, booking_id);
CREATE INDEX IF NOT EXISTS idx_attendance_sync_retry ON attendance_sync_run(status, attempted_at);
CREATE INDEX IF NOT EXISTS idx_attendance_outcome_booking ON attendance_current_outcome(tenant_id, booking_type, booking_id);

-- Existing Zoom links retain the historical one-minute qualifying behaviour.
UPDATE event SET attendance_tracking_enabled = true,
  attendance_provider = COALESCE(attendance_provider, 'zoom'),
  attendance_threshold_minutes = COALESCE(attendance_threshold_minutes, 1)
WHERE (
    zoom_meeting_id IS NOT NULL
    OR zoom_webinar_id IS NOT NULL
    OR EXISTS (
      SELECT 1
      FROM event_agenda_item agenda
      WHERE agenda.event_id = event.id
        AND agenda.tenant_id = event.tenant_id
        AND (agenda.zoom_meeting_id IS NOT NULL OR agenda.zoom_webinar_id IS NOT NULL)
    )
  )
  AND NOT EXISTS (
    SELECT 1
    FROM attendance_policy existing_policy
    WHERE existing_policy.tenant_id = event.tenant_id
      AND existing_policy.owner_type = 'event'
      AND existing_policy.owner_id = event.id
  );
UPDATE complex_event_session SET attendance_tracking_enabled = true,
  attendance_provider = COALESCE(attendance_provider, 'zoom'),
  attendance_threshold_minutes = COALESCE(attendance_threshold_minutes, 1),
  attendance_policy_override = true
WHERE (zoom_meeting_id IS NOT NULL OR zoom_webinar_id IS NOT NULL)
  AND NOT EXISTS (
    SELECT 1
    FROM attendance_policy existing_policy
    WHERE existing_policy.tenant_id = complex_event_session.tenant_id
      AND existing_policy.owner_type = 'complex_event_session'
      AND existing_policy.owner_id = complex_event_session.id
  );

INSERT INTO attendance_policy
  (tenant_id, owner_type, owner_id, enabled, provider, threshold_minutes)
SELECT e.tenant_id, 'event', e.id, true, 'zoom', 1
FROM event e
WHERE e.zoom_meeting_id IS NOT NULL
  OR e.zoom_webinar_id IS NOT NULL
  OR EXISTS (
    SELECT 1
    FROM event_agenda_item agenda
    WHERE agenda.event_id = e.id
      AND agenda.tenant_id = e.tenant_id
      AND (agenda.zoom_meeting_id IS NOT NULL OR agenda.zoom_webinar_id IS NOT NULL)
  )
ON CONFLICT (tenant_id, owner_type, owner_id) DO NOTHING;

INSERT INTO attendance_policy
  (tenant_id, owner_type, owner_id, enabled, provider, threshold_minutes)
SELECT s.tenant_id, 'complex_event_session', s.id, true, 'zoom', 1
FROM complex_event_session s
WHERE s.zoom_meeting_id IS NOT NULL OR s.zoom_webinar_id IS NOT NULL
ON CONFLICT (tenant_id, owner_type, owner_id) DO NOTHING;

INSERT INTO attendance_target
  (tenant_id, provider, target_type, target_id, event_id, provider_target_id,
   provider_target_type, effective_threshold_minutes, tracking_enabled)
SELECT DISTINCT ON (
    za.tenant_id,
    CASE WHEN za.complex_event_session_id IS NULL THEN 'event' ELSE 'complex_event_session' END,
    COALESCE(za.complex_event_session_id, za.event_id)
  )
  za.tenant_id, 'zoom',
  CASE WHEN za.complex_event_session_id IS NULL THEN 'event' ELSE 'complex_event_session' END,
  COALESCE(za.complex_event_session_id, za.event_id), za.event_id, za.zoom_meeting_id,
  COALESCE(za.zoom_type, 'meeting'), 1, true
FROM zoom_attendance za
WHERE COALESCE(za.complex_event_session_id, za.event_id) IS NOT NULL
ORDER BY
  za.tenant_id,
  CASE WHEN za.complex_event_session_id IS NULL THEN 'event' ELSE 'complex_event_session' END,
  COALESCE(za.complex_event_session_id, za.event_id),
  za.synced_at DESC NULLS LAST
ON CONFLICT (tenant_id, provider, target_type, target_id) DO UPDATE
SET provider_target_id = EXCLUDED.provider_target_id, updated_at = now();

UPDATE attendance_target at
SET policy_id = ap.id
FROM attendance_policy ap
WHERE at.tenant_id = ap.tenant_id
  AND ((at.target_type = 'event' AND ap.owner_type = 'event')
    OR (at.target_type = 'complex_event_session' AND ap.owner_type = 'complex_event_session'))
  AND at.target_id = ap.owner_id
  AND at.provider = 'zoom';

INSERT INTO attendance_participant_interval
  (tenant_id, provider, attendance_target_id, participant_key, interval_key,
   participant_email, participant_name, joined_at, left_at, duration_seconds,
   provider_participant_id, source_metadata)
SELECT za.tenant_id, 'zoom', at.id,
  COALESCE(lower(trim(za.participant_email)), 'legacy:' || za.id::text),
  'legacy:' || za.id::text, lower(trim(za.participant_email)), za.participant_name,
  za.join_time, za.leave_time, GREATEST(COALESCE(za.duration_minutes, 0), 0) * 60,
  NULL, jsonb_build_object('legacy_zoom_attendance_id', za.id)
FROM zoom_attendance za
JOIN attendance_target at ON at.tenant_id = za.tenant_id AND at.provider = 'zoom'
 AND at.target_id = COALESCE(za.complex_event_session_id, za.event_id)
ON CONFLICT (tenant_id, provider, attendance_target_id, participant_key, interval_key) DO NOTHING;

INSERT INTO attendance_participant_match
  (tenant_id, provider, attendance_target_id, participant_key, booking_type,
   booking_id, member_id, match_status, matched_by)
SELECT DISTINCT ON (za.tenant_id, at.id,
    COALESCE(lower(trim(za.participant_email)), 'legacy:' || za.id::text))
  za.tenant_id, 'zoom', at.id,
  COALESCE(lower(trim(za.participant_email)), 'legacy:' || za.id::text),
  CASE WHEN za.matched_booking_id IS NULL THEN NULL
       WHEN za.complex_event_session_id IS NULL THEN 'booking'
       ELSE 'complex_event_booking' END,
  za.matched_booking_id, za.matched_member_id,
  CASE WHEN za.matched_booking_id IS NULL THEN 'unmatched' ELSE 'matched' END,
  CASE WHEN za.matched_booking_id IS NULL THEN NULL ELSE 'legacy_zoom_match' END
FROM zoom_attendance za
JOIN attendance_target at ON at.tenant_id = za.tenant_id AND at.provider = 'zoom'
 AND at.target_id = COALESCE(za.complex_event_session_id, za.event_id)
ORDER BY za.tenant_id, at.id,
  COALESCE(lower(trim(za.participant_email)), 'legacy:' || za.id::text),
  (za.matched_booking_id IS NOT NULL) DESC
ON CONFLICT DO NOTHING;

WITH target_bookings AS (
  SELECT at.tenant_id, at.id target_id, 'booking'::text booking_type, b.id booking_id
  FROM attendance_target at JOIN booking b
    ON at.target_type = 'event' AND b.event_id = at.event_id
    AND b.tenant_id = at.tenant_id AND b.status = 'confirmed'
  WHERE at.provider = 'zoom'
  UNION ALL
  SELECT at.tenant_id, at.id, 'complex_event_booking', b.id
  FROM attendance_target at JOIN complex_event_booking b
    ON at.target_type = 'complex_event_session' AND b.event_id = at.event_id
    AND b.tenant_id = at.tenant_id AND b.status = 'confirmed'
  WHERE at.provider = 'zoom'
), evaluated AS (
  SELECT tb.*, COALESCE(sum(api.duration_seconds), 0)::integer duration_seconds
  FROM target_bookings tb
  LEFT JOIN attendance_participant_match apm ON apm.tenant_id = tb.tenant_id
    AND apm.attendance_target_id = tb.target_id AND apm.booking_id = tb.booking_id
    AND apm.booking_type = tb.booking_type AND apm.match_status = 'matched'
  LEFT JOIN attendance_participant_interval api ON api.tenant_id = tb.tenant_id
    AND api.attendance_target_id = tb.target_id AND api.participant_key = apm.participant_key
  GROUP BY tb.tenant_id, tb.target_id, tb.booking_type, tb.booking_id
)
INSERT INTO attendance_outcome_revision
  (tenant_id, provider, attendance_target_id, booking_type, booking_id,
   revision_number, status, duration_seconds, threshold_minutes, result_fingerprint)
SELECT tenant_id, 'zoom', target_id, booking_type, booking_id, 1,
  CASE WHEN duration_seconds = 0 THEN 'absent'
       WHEN duration_seconds >= 60 THEN 'attended' ELSE 'below_threshold' END,
  duration_seconds, 1,
  md5((CASE WHEN duration_seconds = 0 THEN 'absent'
       WHEN duration_seconds >= 60 THEN 'attended' ELSE 'below_threshold' END)
      || '|' || duration_seconds::text || '|1')
FROM evaluated
ON CONFLICT (tenant_id, provider, attendance_target_id, booking_type, booking_id, revision_number)
DO NOTHING;

INSERT INTO attendance_current_outcome
  (tenant_id, provider, attendance_target_id, booking_type, booking_id,
   outcome_revision_id, status, duration_seconds, threshold_minutes)
SELECT r.tenant_id, r.provider, r.attendance_target_id, r.booking_type, r.booking_id,
  r.id, r.status, r.duration_seconds, r.threshold_minutes
FROM attendance_outcome_revision r
WHERE r.provider = 'zoom' AND r.revision_number = 1
ON CONFLICT (tenant_id, provider, attendance_target_id, booking_type, booking_id) DO NOTHING;

ALTER TABLE attendance_policy ENABLE ROW LEVEL SECURITY;
ALTER TABLE attendance_target ENABLE ROW LEVEL SECURITY;
ALTER TABLE attendance_sync_run ENABLE ROW LEVEL SECURITY;
ALTER TABLE attendance_participant_interval ENABLE ROW LEVEL SECURITY;
ALTER TABLE attendance_participant_match ENABLE ROW LEVEL SECURITY;
ALTER TABLE attendance_outcome_revision ENABLE ROW LEVEL SECURITY;
ALTER TABLE attendance_current_outcome ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['attendance_policy','attendance_target','attendance_sync_run',
    'attendance_participant_interval','attendance_participant_match',
    'attendance_outcome_revision','attendance_current_outcome']
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS service_role_all ON %I', t);
    EXECUTE format('CREATE POLICY service_role_all ON %I FOR ALL TO service_role USING (true) WITH CHECK (true)', t);
  END LOOP;
END $$;

-- A report replacement is deliberately one transaction: readers can never see
-- a half-replaced interval set or a run marked successful before outcomes.
DO $$
DECLARE c record;
BEGIN
  FOR c IN SELECT conname FROM pg_constraint
    WHERE conrelid = 'attendance_participant_match'::regclass AND contype = 'u'
      AND pg_get_constraintdef(oid) LIKE '%participant_key)%'
  LOOP
    EXECUTE format('ALTER TABLE attendance_participant_match DROP CONSTRAINT %I', c.conname);
  END LOOP;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS idx_attendance_match_participant_booking
  ON attendance_participant_match
  (tenant_id, provider, attendance_target_id, participant_key, COALESCE(booking_id, '00000000-0000-0000-0000-000000000000'::uuid));

CREATE OR REPLACE FUNCTION attendance_upsert_policy_snapshot(p_tenant_id uuid, p_policy jsonb)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_parent uuid; v_id uuid;
BEGIN
  IF p_policy IS NULL OR p_policy = 'null'::jsonb THEN RETURN NULL; END IF;
  v_parent := attendance_upsert_policy_snapshot(p_tenant_id, p_policy->'parent');
  INSERT INTO attendance_policy (tenant_id,owner_type,owner_id,enabled,provider,threshold_minutes,inherits_from_policy_id,updated_at)
  VALUES (p_tenant_id,p_policy->>'ownerType',(p_policy->>'ownerId')::uuid,
    COALESCE((p_policy->>'enabled')::boolean,false),p_policy->>'provider',
    COALESCE((p_policy->>'thresholdMinutes')::integer,1),v_parent,now())
  ON CONFLICT (tenant_id,owner_type,owner_id) DO UPDATE SET
    enabled=EXCLUDED.enabled, provider=EXCLUDED.provider, threshold_minutes=EXCLUDED.threshold_minutes,
    inherits_from_policy_id=EXCLUDED.inherits_from_policy_id, updated_at=now()
  RETURNING id INTO v_id;
  RETURN v_id;
END $$;

CREATE OR REPLACE FUNCTION replace_attendance_report_snapshot(
  p_tenant_id uuid, p_provider text, p_idempotency_key text, p_snapshot jsonb
) RETURNS TABLE(target_id uuid, sync_run_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_target uuid; v_run uuid; v_existing_status text; v_policy uuid; v_item jsonb;
  v_revision uuid; v_number integer; v_type text; v_booking uuid; v_fingerprint text;
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
      SELECT 1
      FROM jsonb_array_elements(COALESCE(p_snapshot->'outcomes','[]'::jsonb)) outcome
      WHERE outcome->>'bookingType'=current_outcome.booking_type
        AND (outcome->>'bookingId')::uuid=current_outcome.booking_id
    );
  FOR v_item IN SELECT value FROM jsonb_array_elements(COALESCE(p_snapshot->'outcomes','[]'::jsonb)) LOOP
    v_type := v_item->>'bookingType'; v_booking := (v_item->>'bookingId')::uuid; v_fingerprint := v_item->>'resultFingerprint';
    SELECT id INTO v_revision FROM attendance_outcome_revision WHERE tenant_id=p_tenant_id AND provider=p_provider
      AND attendance_target_id=v_target AND booking_type=v_type AND booking_id=v_booking AND result_fingerprint=v_fingerprint;
    IF v_revision IS NULL THEN
      SELECT COALESCE(max(revision_number),0)+1 INTO v_number FROM attendance_outcome_revision
        WHERE tenant_id=p_tenant_id AND provider=p_provider AND attendance_target_id=v_target AND booking_type=v_type AND booking_id=v_booking;
      INSERT INTO attendance_outcome_revision (tenant_id,provider,attendance_target_id,booking_type,booking_id,revision_number,
        status,duration_seconds,threshold_minutes,sync_run_id,result_fingerprint)
      VALUES (p_tenant_id,p_provider,v_target,v_type,v_booking,v_number,v_item->>'status',
        COALESCE((v_item->>'durationSeconds')::integer,0),COALESCE((v_item->>'thresholdMinutes')::integer,1),v_run,v_fingerprint)
      RETURNING id INTO v_revision;
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

REVOKE ALL ON FUNCTION attendance_upsert_policy_snapshot(uuid,jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION replace_attendance_report_snapshot(uuid,text,text,jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION replace_attendance_report_snapshot(uuid,text,text,jsonb) TO service_role;