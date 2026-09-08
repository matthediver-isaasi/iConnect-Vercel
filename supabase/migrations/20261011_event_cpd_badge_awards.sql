-- Task #4219: tenant-scoped CPD badge rules and reliable award delivery.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS public.event_cpd_badge_rule (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenant(id) ON DELETE CASCADE,
  event_type text NOT NULL CHECK (event_type IN ('event','complex_event')),
  event_id uuid NOT NULL,
  trigger_type text NOT NULL CHECK (trigger_type IN ('registration','attendance')),
  ticket_id text,
  ticket_name_snapshot text,
  badge_id uuid REFERENCES public.badge(id) ON DELETE RESTRICT,
  badge_name_snapshot text,
  is_no_award boolean NOT NULL DEFAULT false,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  removed_at timestamptz,
  CHECK ((is_no_award AND ticket_id IS NOT NULL AND badge_id IS NULL)
    OR (NOT is_no_award AND badge_id IS NOT NULL))
);
-- A ticket override is deliberately trigger-independent: configuring a ticket
-- must never accidentally leave the other trigger inherited from the event.
DROP INDEX IF EXISTS public.uq_event_cpd_rule_event_wide;
DROP INDEX IF EXISTS public.uq_event_cpd_rule_ticket;
CREATE UNIQUE INDEX IF NOT EXISTS uq_event_cpd_rule_event_wide ON public.event_cpd_badge_rule
  (tenant_id,event_type,event_id) WHERE ticket_id IS NULL AND active;
CREATE UNIQUE INDEX IF NOT EXISTS uq_event_cpd_rule_ticket ON public.event_cpd_badge_rule
  (tenant_id,event_type,event_id,ticket_id) WHERE ticket_id IS NOT NULL AND active;
CREATE INDEX IF NOT EXISTS idx_event_cpd_rule_resolve ON public.event_cpd_badge_rule
  (tenant_id,event_type,event_id,trigger_type,ticket_id) WHERE active;

CREATE OR REPLACE FUNCTION public.validate_event_cpd_badge_rule()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_name text; v_ticket_name text;
BEGIN
  -- Rules are immutable once archived.  In particular, a deleted ticket or a
  -- subsequently deactivated badge must not make a historical soft-delete
  -- impossible. Preserve the original tenant/event identity and snapshots.
  IF TG_OP='UPDATE' AND NOT NEW.active THEN
    IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
       OR NEW.event_type IS DISTINCT FROM OLD.event_type
       OR NEW.event_id IS DISTINCT FROM OLD.event_id THEN
      RAISE EXCEPTION 'archived CPD rule identity cannot change';
    END IF;
    NEW.ticket_id := OLD.ticket_id;
    NEW.ticket_name_snapshot := OLD.ticket_name_snapshot;
    NEW.badge_id := OLD.badge_id;
    NEW.badge_name_snapshot := OLD.badge_name_snapshot;
    NEW.is_no_award := OLD.is_no_award;
    NEW.removed_at := COALESCE(NEW.removed_at,now());
    NEW.updated_at := now();
    RETURN NEW;
  END IF;
  IF NEW.event_type='event' THEN
    IF NOT EXISTS (SELECT 1 FROM event WHERE id=NEW.event_id AND tenant_id=NEW.tenant_id) THEN
      RAISE EXCEPTION 'event does not belong to tenant';
    END IF;
    IF NEW.ticket_id IS NOT NULL THEN
      SELECT ticket->>'name' INTO v_ticket_name
      FROM event e CROSS JOIN LATERAL jsonb_array_elements(
        CASE WHEN jsonb_typeof(e.pricing_config->'ticket_classes')='array'
          THEN e.pricing_config->'ticket_classes' ELSE '[]'::jsonb END
      ) ticket
      WHERE e.id=NEW.event_id AND e.tenant_id=NEW.tenant_id
        AND ticket->>'id'=NEW.ticket_id LIMIT 1;
      IF v_ticket_name IS NULL THEN RAISE EXCEPTION 'ticket does not belong to event and tenant'; END IF;
    END IF;
  ELSE
    -- complex_event_booking.ticket_class_id is the authoritative persisted
    -- booking ticket source used by api/public/complex-event-booking.js.
    IF NOT EXISTS (SELECT 1 FROM complex_event WHERE id=NEW.event_id AND tenant_id=NEW.tenant_id) THEN
      RAISE EXCEPTION 'complex event does not belong to tenant';
    END IF;
    IF NEW.ticket_id IS NOT NULL THEN
      SELECT name INTO v_ticket_name FROM complex_event_ticket_class
      WHERE id::text=NEW.ticket_id AND complex_event_id=NEW.event_id AND tenant_id=NEW.tenant_id;
      IF v_ticket_name IS NULL THEN RAISE EXCEPTION 'ticket does not belong to complex event and tenant'; END IF;
    END IF;
  END IF;
  IF NEW.is_no_award THEN
    IF NEW.ticket_id IS NULL OR NEW.badge_id IS NOT NULL THEN
      RAISE EXCEPTION 'no-award rules must be ticket scoped and have no badge';
    END IF;
    NEW.badge_name_snapshot := NULL;
  ELSE
    SELECT name INTO v_name FROM badge WHERE id=NEW.badge_id AND tenant_id=NEW.tenant_id AND is_active;
    IF v_name IS NULL THEN RAISE EXCEPTION 'active badge does not belong to tenant'; END IF;
    NEW.badge_name_snapshot := v_name;
  END IF;
  IF NEW.ticket_id IS NOT NULL THEN NEW.ticket_name_snapshot := v_ticket_name; END IF;
  NEW.updated_at := now();
  IF NOT NEW.active THEN NEW.removed_at := COALESCE(NEW.removed_at,now()); END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS validate_event_cpd_badge_rule ON public.event_cpd_badge_rule;
CREATE TRIGGER validate_event_cpd_badge_rule BEFORE INSERT OR UPDATE ON public.event_cpd_badge_rule
FOR EACH ROW EXECUTE FUNCTION public.validate_event_cpd_badge_rule();

-- Replacing configuration is one transaction.  A failed validation leaves the
-- previous active set untouched; old rows remain as immutable award provenance.
CREATE OR REPLACE FUNCTION public.replace_event_cpd_badge_rules(
  p_tenant_id uuid, p_event_type text, p_event_id uuid, p_rules jsonb
) RETURNS SETOF public.event_cpd_badge_rule
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_rule jsonb; v_count integer;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'service_role is required';
  END IF;
  IF p_tenant_id IS NULL OR p_event_type NOT IN ('event','complex_event') OR p_event_id IS NULL
     OR jsonb_typeof(p_rules) <> 'array' THEN RAISE EXCEPTION 'tenant, event type, event and rules array are required'; END IF;
  IF p_event_type='event' AND NOT EXISTS (SELECT 1 FROM event WHERE id=p_event_id AND tenant_id=p_tenant_id) THEN
    RAISE EXCEPTION 'event does not belong to tenant';
  ELSIF p_event_type='complex_event' AND NOT EXISTS (SELECT 1 FROM complex_event WHERE id=p_event_id AND tenant_id=p_tenant_id) THEN
    RAISE EXCEPTION 'complex event does not belong to tenant';
  END IF;
  SELECT count(*) INTO v_count FROM jsonb_array_elements(p_rules);
  IF v_count > 501 THEN RAISE EXCEPTION 'at most 501 rules are allowed'; END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_rules) r
    WHERE r->>'trigger_type' IS NULL
      OR r->>'trigger_type' NOT IN ('registration','attendance')
      OR (r->>'ticket_id' IS NULL AND COALESCE((r->>'is_no_award')::boolean,false))
  ) THEN RAISE EXCEPTION 'invalid CPD rule'; END IF;
  IF (SELECT count(*) FROM jsonb_array_elements(p_rules) r WHERE r->>'ticket_id' IS NULL) > 1 THEN
    RAISE EXCEPTION 'only one event-wide rule is allowed';
  END IF;
  -- Serialize replacement for this event, including concurrent admin saves.
  PERFORM pg_advisory_xact_lock(hashtextextended(p_tenant_id::text||':'||p_event_type||':'||p_event_id::text,0));
  -- jsonb recordset plus GROUP BY gives a clear error before changing history.
  IF EXISTS (
    SELECT ticket_id FROM jsonb_to_recordset(p_rules) AS r(ticket_id text)
    WHERE ticket_id IS NOT NULL GROUP BY ticket_id HAVING count(*) > 1
  ) THEN RAISE EXCEPTION 'only one ticket override is allowed per ticket'; END IF;
  UPDATE event_cpd_badge_rule SET active=false,removed_at=now(),updated_at=now()
    WHERE tenant_id=p_tenant_id AND event_type=p_event_type AND event_id=p_event_id AND active;
  FOR v_rule IN SELECT value FROM jsonb_array_elements(p_rules) LOOP
    INSERT INTO event_cpd_badge_rule(
      tenant_id,event_type,event_id,trigger_type,ticket_id,ticket_name_snapshot,
      badge_id,badge_name_snapshot,is_no_award,active
    ) VALUES (
      p_tenant_id,p_event_type,p_event_id,v_rule->>'trigger_type',
      NULLIF(v_rule->>'ticket_id',''),NULLIF(v_rule->>'ticket_name_snapshot',''),
      NULLIF(v_rule->>'badge_id','')::uuid,NULLIF(v_rule->>'badge_name_snapshot',''),
      COALESCE((v_rule->>'is_no_award')::boolean,false),true
    );
  END LOOP;
  RETURN QUERY SELECT * FROM event_cpd_badge_rule
    WHERE tenant_id=p_tenant_id AND event_type=p_event_type AND event_id=p_event_id AND active
    ORDER BY created_at,id;
END $$;

ALTER TABLE public.member_badge
  ADD COLUMN IF NOT EXISTS event_type text,
  ADD COLUMN IF NOT EXISTS event_id uuid,
  ADD COLUMN IF NOT EXISTS booking_type text,
  ADD COLUMN IF NOT EXISTS booking_id uuid,
  ADD COLUMN IF NOT EXISTS ticket_id text,
  ADD COLUMN IF NOT EXISTS ticket_name_snapshot text,
  ADD COLUMN IF NOT EXISTS award_trigger text,
  ADD COLUMN IF NOT EXISTS evidence_type text,
  ADD COLUMN IF NOT EXISTS evidence_id text,
  ADD COLUMN IF NOT EXISTS cpd_rule_id uuid REFERENCES public.event_cpd_badge_rule(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS award_provenance jsonb NOT NULL DEFAULT '{}'::jsonb;

-- Service-role writes still receive database-level tenant and booking checks.
-- This also closes a cancellation race between resolving a booking and writing
-- its badge assignment.
CREATE OR REPLACE FUNCTION public.validate_event_cpd_member_badge()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
BEGIN
  IF NEW.source IS DISTINCT FROM 'event_cpd' THEN RETURN NEW; END IF;
  IF NEW.booking_type='booking' THEN
    IF NOT EXISTS (
      SELECT 1 FROM booking b
      JOIN member m ON m.id=NEW.member_id AND m.tenant_id=b.tenant_id
        AND NULLIF(lower(trim(b.attendee_email)),'')=lower(trim(m.email))
      WHERE b.id=NEW.booking_id
        AND b.tenant_id=NEW.tenant_id AND b.event_id=NEW.event_id
        AND b.status='confirmed'
    ) THEN RAISE EXCEPTION 'confirmed tenant booking is required for CPD award'; END IF;
  ELSIF NEW.booking_type='complex_event_booking' THEN
    IF NOT EXISTS (
      SELECT 1 FROM complex_event_booking b
      JOIN member m ON m.id=NEW.member_id AND m.tenant_id=b.tenant_id
        AND NULLIF(lower(trim(b.attendee_email)),'')=lower(trim(m.email))
      WHERE b.id=NEW.booking_id
        AND b.tenant_id=NEW.tenant_id AND b.event_id=NEW.event_id
        AND b.status='confirmed'
    ) THEN RAISE EXCEPTION 'confirmed tenant complex booking is required for CPD award'; END IF;
  ELSE
    RAISE EXCEPTION 'valid booking type is required for CPD award';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM member WHERE id=NEW.member_id AND tenant_id=NEW.tenant_id) THEN
    RAISE EXCEPTION 'member does not belong to award tenant';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM badge WHERE id=NEW.badge_id AND tenant_id=NEW.tenant_id AND is_active) THEN
    RAISE EXCEPTION 'badge does not belong to award tenant';
  END IF;
  IF NEW.cpd_rule_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM event_cpd_badge_rule r WHERE r.id=NEW.cpd_rule_id
      AND r.tenant_id=NEW.tenant_id AND r.event_type=NEW.event_type
      AND r.event_id=NEW.event_id AND r.badge_id=NEW.badge_id
  ) THEN RAISE EXCEPTION 'CPD rule does not belong to award tenant and event'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS validate_event_cpd_member_badge ON public.member_badge;
-- Current booking/badge eligibility is an award-time concern. Later updates
-- (including manual revocation) must not be blocked after those facts change.
CREATE TRIGGER validate_event_cpd_member_badge BEFORE INSERT ON public.member_badge
FOR EACH ROW EXECUTE FUNCTION public.validate_event_cpd_member_badge();

CREATE TABLE IF NOT EXISTS public.event_cpd_badge_award_attempt (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenant(id) ON DELETE CASCADE,
  idempotency_key text NOT NULL,
  event_type text NOT NULL CHECK (event_type IN ('event','complex_event')),
  event_id uuid NOT NULL,
  booking_type text NOT NULL CHECK (booking_type IN ('booking','complex_event_booking')),
  booking_id uuid NOT NULL,
  member_id uuid,
  ticket_id text,
  ticket_name_snapshot text,
  trigger_type text NOT NULL CHECK (trigger_type IN ('registration','attendance')),
  evidence_type text,
  evidence_id text,
  evidence_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  rule_id uuid REFERENCES public.event_cpd_badge_rule(id) ON DELETE SET NULL,
  badge_id uuid REFERENCES public.badge(id) ON DELETE RESTRICT,
  member_badge_id uuid REFERENCES public.member_badge(id) ON DELETE SET NULL,
  status text NOT NULL CHECK (status IN
    ('granted','already_awarded','skipped_cancelled','skipped_unmatched',
     'skipped_no_rule','skipped_not_qualifying','pending_evidence','error')),
  detail text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id,idempotency_key)
);
CREATE INDEX IF NOT EXISTS idx_event_cpd_attempt_booking ON public.event_cpd_badge_award_attempt
  (tenant_id,booking_type,booking_id,created_at);

-- Atomically record every outcome and, when eligible, its member badge. The
-- event advisory lock is shared with configuration replacement so a request
-- can never grant from one configuration and record against another.
CREATE OR REPLACE FUNCTION public.record_event_cpd_badge_award(p_attempt jsonb)
RETURNS public.event_cpd_badge_award_attempt
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE
  v_tenant uuid := (p_attempt->>'tenant_id')::uuid;
  v_key text := p_attempt->>'idempotency_key';
  v_booking_type text := p_attempt->>'booking_type';
  v_booking_id uuid := (p_attempt->>'booking_id')::uuid;
  v_event_type text := p_attempt->>'event_type';
  v_event_id uuid;
  v_booking_status text;
  v_attendee_email text;
  v_ticket_id text;
  v_ticket_name text;
  v_booking_checked_at timestamptz;
  v_booking_reversed_at timestamptz;
  v_member uuid := NULLIF(p_attempt->>'member_id','')::uuid;
  v_rule uuid;
  v_badge uuid;
  v_rule_trigger text;
  v_rule_no_award boolean;
  v_member_badge uuid;
  v_status text := p_attempt->>'status';
  v_detail text := NULLIF(p_attempt->>'detail','');
  v_evidence jsonb := COALESCE(p_attempt->'evidence_snapshot','{}'::jsonb);
  v_queued_checked_at timestamptz;
  v_current_checked_at timestamptz;
  v_current_reversed_at timestamptz;
  v_current_status text;
  v_current_revision uuid;
  v_result event_cpd_badge_award_attempt%ROWTYPE;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'service_role is required';
  END IF;
  IF v_tenant IS NULL OR NULLIF(v_key,'') IS NULL
     OR v_booking_type NOT IN ('booking','complex_event_booking') THEN
    RAISE EXCEPTION 'invalid CPD award attempt';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(v_tenant::text||':cpd-attempt:'||v_key,0));
  SELECT * INTO v_result FROM event_cpd_badge_award_attempt
    WHERE tenant_id=v_tenant AND idempotency_key=v_key;
  IF FOUND THEN RETURN v_result; END IF;

  IF v_booking_type='booking' THEN
    SELECT event_id,status,attendee_email,ticket_class_id,ticket_class_name,
           checked_in_at,check_in_reversed_at
      INTO v_event_id,v_booking_status,v_attendee_email,v_ticket_id,v_ticket_name,
           v_booking_checked_at,v_booking_reversed_at
    FROM booking WHERE id=v_booking_id AND tenant_id=v_tenant FOR UPDATE;
    IF v_event_type IS DISTINCT FROM 'event' THEN RAISE EXCEPTION 'booking event type mismatch'; END IF;
  ELSE
    SELECT event_id,status,attendee_email,ticket_class_id,ticket_class_name
      INTO v_event_id,v_booking_status,v_attendee_email,v_ticket_id,v_ticket_name
    FROM complex_event_booking WHERE id=v_booking_id AND tenant_id=v_tenant FOR UPDATE;
    IF v_event_type IS DISTINCT FROM 'complex_event' THEN RAISE EXCEPTION 'booking event type mismatch'; END IF;
  END IF;
  IF v_event_id IS NULL THEN RAISE EXCEPTION 'tenant booking not found'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(
    v_tenant::text||':'||v_event_type||':'||v_event_id::text,0));

  IF v_status='granted' THEN
    IF v_booking_status <> 'confirmed' THEN v_status:='skipped_cancelled'; END IF;
    IF v_status='granted' AND (
      v_member IS NULL OR NULLIF(lower(trim(v_attendee_email)),'') IS NULL OR NOT EXISTS (
        SELECT 1 FROM member m WHERE m.id=v_member AND m.tenant_id=v_tenant
          AND lower(trim(m.email))=lower(trim(v_attendee_email))
      )
    ) THEN v_status:='skipped_unmatched'; END IF;
    IF v_status='granted' AND p_attempt->>'trigger_type'='attendance' THEN
      IF p_attempt->>'evidence_type'='qr_checkin' THEN
        BEGIN
          v_queued_checked_at := NULLIF(v_evidence->>'checkedInAt','')::timestamptz;
        EXCEPTION WHEN OTHERS THEN
          v_queued_checked_at := NULL;
        END;
        IF v_booking_type='booking' THEN
          IF p_attempt->>'evidence_id' IS DISTINCT FROM v_booking_id::text
             OR v_queued_checked_at IS NULL
             OR v_booking_checked_at IS DISTINCT FROM v_queued_checked_at
             OR (v_booking_reversed_at IS NOT NULL AND v_booking_checked_at<=v_booking_reversed_at) THEN
            v_status:='skipped_not_qualifying'; v_detail:='checkin_not_current';
          END IF;
        ELSE
          SELECT c.checked_in_at,c.check_in_reversed_at
            INTO v_current_checked_at,v_current_reversed_at
          FROM complex_event_session_checkin c
          JOIN complex_event_session s ON s.id=c.session_id
            AND s.tenant_id=c.tenant_id AND s.complex_event_id=c.complex_event_id
          WHERE c.id::text=(p_attempt->>'evidence_id') AND c.tenant_id=v_tenant
            AND c.booking_id=v_booking_id AND c.complex_event_id=v_event_id
          FOR UPDATE OF c;
          IF v_current_checked_at IS NULL OR v_queued_checked_at IS NULL
             OR v_current_checked_at IS DISTINCT FROM v_queued_checked_at
             OR (v_current_reversed_at IS NOT NULL AND v_current_checked_at<=v_current_reversed_at) THEN
            v_status:='skipped_not_qualifying'; v_detail:='checkin_not_current';
          END IF;
        END IF;
      ELSIF p_attempt->>'evidence_type' IN ('zoom','teams') THEN
        SELECT status,outcome_revision_id INTO v_current_status,v_current_revision
        FROM attendance_current_outcome
        WHERE tenant_id=v_tenant AND provider=(p_attempt->>'evidence_type')
          AND attendance_target_id::text=(v_evidence->>'attendanceTargetId')
          AND booking_type=v_booking_type AND booking_id=v_booking_id
        FOR UPDATE;
        IF v_current_status IS NULL OR v_current_status IN ('pending','error','unmatched') THEN
          v_status:='pending_evidence'; v_detail:='outcome_superseded_or_unresolved';
        ELSIF (v_evidence->>'status') IS DISTINCT FROM 'attended'
           OR (v_evidence->>'type') IS DISTINCT FROM (p_attempt->>'evidence_type')
           OR v_current_status<>'attended'
           OR v_current_revision::text IS DISTINCT FROM (v_evidence->>'revisionId') THEN
          v_status:='skipped_not_qualifying'; v_detail:='outcome_not_current_attended';
        END IF;
      ELSE
        v_status:='pending_evidence'; v_detail:='evidence_unavailable';
      END IF;
    END IF;
    IF v_status='granted' THEN
      -- Resolve under the same event lock as replacement. Any ticket override
      -- suppresses event-wide fallback, even when it uses another trigger.
      SELECT r.id,r.badge_id,r.trigger_type,r.is_no_award
        INTO v_rule,v_badge,v_rule_trigger,v_rule_no_award
      FROM event_cpd_badge_rule r
      WHERE r.tenant_id=v_tenant AND r.event_type=v_event_type
        AND r.event_id=v_event_id AND r.active
        AND (
          r.ticket_id=v_ticket_id
          OR (
            r.ticket_id IS NULL AND r.trigger_type=(p_attempt->>'trigger_type')
            AND NOT EXISTS (
              SELECT 1 FROM event_cpd_badge_rule override_rule
              WHERE override_rule.tenant_id=v_tenant
                AND override_rule.event_type=v_event_type
                AND override_rule.event_id=v_event_id AND override_rule.active
                AND override_rule.ticket_id=v_ticket_id
            )
          )
        )
      ORDER BY (r.ticket_id IS NOT NULL) DESC
      LIMIT 1;
      IF v_rule IS NULL OR v_rule_no_award
         OR v_rule_trigger IS DISTINCT FROM (p_attempt->>'trigger_type') THEN
        v_status:='skipped_no_rule';
      ELSIF NOT EXISTS (
        SELECT 1 FROM badge b
        WHERE b.id=v_badge AND b.tenant_id=v_tenant AND b.is_active
      ) THEN
        v_status:='skipped_no_rule';
      END IF;
    END IF;
  END IF;

  IF v_status='granted' THEN
    SELECT id INTO v_member_badge FROM member_badge
      WHERE tenant_id=v_tenant AND member_id=v_member AND badge_id=v_badge AND revoked_at IS NULL;
    IF v_member_badge IS NOT NULL THEN
      v_status:='already_awarded';
    ELSE
      INSERT INTO member_badge(
        tenant_id,member_id,badge_id,source,source_ref,created_by,
        awarded_by_type,awarded_by_label,event_type,event_id,booking_type,booking_id,
        ticket_id,ticket_name_snapshot,award_trigger,evidence_type,evidence_id,
        cpd_rule_id,award_provenance
      ) VALUES (
        v_tenant,v_member,v_badge,'event_cpd',v_event_type||':'||v_event_id::text,
        'system:event-cpd','system','Event CPD badge automation',v_event_type,v_event_id,
        v_booking_type,v_booking_id,v_ticket_id,COALESCE(v_ticket_name,p_attempt->>'ticket_name_snapshot'),
        p_attempt->>'trigger_type',NULLIF(p_attempt->>'evidence_type',''),
        NULLIF(p_attempt->>'evidence_id',''),v_rule,COALESCE(p_attempt->'evidence_snapshot','{}'::jsonb)
      ) RETURNING id INTO v_member_badge;
    END IF;
  END IF;

  INSERT INTO event_cpd_badge_award_attempt(
    tenant_id,idempotency_key,event_type,event_id,booking_type,booking_id,member_id,
    ticket_id,ticket_name_snapshot,trigger_type,evidence_type,evidence_id,evidence_snapshot,
    rule_id,badge_id,member_badge_id,status,detail
  ) VALUES (
    v_tenant,v_key,v_event_type,v_event_id,v_booking_type,v_booking_id,v_member,
    v_ticket_id,COALESCE(v_ticket_name,p_attempt->>'ticket_name_snapshot'),
    p_attempt->>'trigger_type',NULLIF(p_attempt->>'evidence_type',''),
    NULLIF(p_attempt->>'evidence_id',''),COALESCE(p_attempt->'evidence_snapshot','{}'::jsonb),
    v_rule,v_badge,v_member_badge,v_status,v_detail
  ) RETURNING * INTO v_result;
  RETURN v_result;
END $$;

CREATE TABLE IF NOT EXISTS public.event_cpd_badge_outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  idempotency_key text NOT NULL,
  booking_type text NOT NULL,
  booking_id uuid NOT NULL,
  trigger_type text NOT NULL,
  evidence_type text,
  evidence_id text,
  evidence_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','processing','retry','complete','dead')),
  attempts integer NOT NULL DEFAULT 0,
  available_at timestamptz NOT NULL DEFAULT now(),
  locked_at timestamptz,
  lock_token uuid,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id,idempotency_key)
);
CREATE INDEX IF NOT EXISTS idx_event_cpd_outbox_ready ON public.event_cpd_badge_outbox(status,available_at,created_at)
  WHERE status IN ('pending','retry','processing');

CREATE OR REPLACE FUNCTION public.enqueue_event_cpd_from_booking()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_type text; v_key text;
BEGIN
  IF NEW.status='confirmed' AND (TG_OP='INSERT' OR OLD.status IS DISTINCT FROM NEW.status) THEN
    v_type := CASE TG_TABLE_NAME WHEN 'booking' THEN 'booking' ELSE 'complex_event_booking' END;
    v_key := 'registration:'||v_type||':'||NEW.id::text;
    INSERT INTO event_cpd_badge_outbox(tenant_id,idempotency_key,booking_type,booking_id,trigger_type,evidence_type,evidence_id)
    VALUES(NEW.tenant_id,v_key,v_type,NEW.id,'registration','confirmed_booking',NEW.id::text)
    ON CONFLICT (tenant_id,idempotency_key) DO NOTHING;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS enqueue_event_cpd_booking ON public.booking;
CREATE TRIGGER enqueue_event_cpd_booking AFTER INSERT OR UPDATE OF status ON public.booking
FOR EACH ROW EXECUTE FUNCTION public.enqueue_event_cpd_from_booking();
DROP TRIGGER IF EXISTS enqueue_event_cpd_complex_booking ON public.complex_event_booking;
CREATE TRIGGER enqueue_event_cpd_complex_booking AFTER INSERT OR UPDATE OF status ON public.complex_event_booking
FOR EACH ROW EXECUTE FUNCTION public.enqueue_event_cpd_from_booking();

CREATE OR REPLACE FUNCTION public.enqueue_event_cpd_from_checkin()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_booking uuid; v_tenant uuid; v_type text; v_evidence text; v_key text; v_snapshot jsonb;
BEGIN
  IF NEW.checked_in_at IS NOT NULL AND (TG_OP='INSERT' OR OLD.checked_in_at IS NULL) THEN
    IF TG_TABLE_NAME='booking' THEN
      v_booking:=NEW.id; v_tenant:=NEW.tenant_id; v_type:='booking'; v_evidence:=NEW.id::text;
      v_snapshot:=jsonb_build_object(
        'checkedInAt',NEW.checked_in_at,'checkinRecordId',v_evidence,
        'checkInReversedAt',NEW.check_in_reversed_at
      );
    ELSE
      -- The check-in row is not authoritative by itself: ensure its tenant,
      -- session, complex event and booking all describe the same registration.
      IF NOT EXISTS (
        SELECT 1
        FROM complex_event_booking b
        JOIN complex_event_session s
          ON s.id=NEW.session_id AND s.tenant_id=NEW.tenant_id
             AND s.complex_event_id=NEW.complex_event_id
        WHERE b.id=NEW.booking_id AND b.tenant_id=NEW.tenant_id
          AND b.event_id=NEW.complex_event_id
      ) THEN
        RAISE EXCEPTION 'complex check-in does not match tenant event booking and session';
      END IF;
      v_booking:=NEW.booking_id; v_tenant:=NEW.tenant_id; v_type:='complex_event_booking'; v_evidence:=NEW.id::text;
      v_snapshot:=jsonb_build_object(
        'checkedInAt',NEW.checked_in_at,'checkinRecordId',v_evidence,
        'sessionId',NEW.session_id,'complexEventId',NEW.complex_event_id,
        'checkInReversedAt',NEW.check_in_reversed_at
      );
    END IF;
    -- checked_in_at identifies a check-in generation. Undo/re-check-in keeps
    -- the same token/record id but must create new independently eligible work.
    v_key:='attendance:qr:'||v_type||':'||v_evidence||':'||NEW.checked_in_at::text;
    INSERT INTO event_cpd_badge_outbox(tenant_id,idempotency_key,booking_type,booking_id,trigger_type,evidence_type,evidence_id,evidence_snapshot)
    VALUES(v_tenant,v_key,v_type,v_booking,'attendance','qr_checkin',v_evidence,v_snapshot)
    ON CONFLICT (tenant_id,idempotency_key) DO NOTHING;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS enqueue_event_cpd_simple_checkin ON public.booking;
CREATE TRIGGER enqueue_event_cpd_simple_checkin AFTER INSERT OR UPDATE OF checked_in_at ON public.booking
FOR EACH ROW EXECUTE FUNCTION public.enqueue_event_cpd_from_checkin();
DROP TRIGGER IF EXISTS enqueue_event_cpd_complex_checkin ON public.complex_event_session_checkin;
CREATE TRIGGER enqueue_event_cpd_complex_checkin AFTER INSERT OR UPDATE OF checked_in_at ON public.complex_event_session_checkin
FOR EACH ROW EXECUTE FUNCTION public.enqueue_event_cpd_from_checkin();

-- Publish online CPD evidence in the same transaction as the immutable
-- provider-neutral transition. CPD processing is intentionally independent of
-- workflow publication and therefore cannot delay unrelated workflows.
CREATE OR REPLACE FUNCTION public.enqueue_event_cpd_from_attendance_transition()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_key text;
BEGIN
  IF NEW.provider NOT IN ('zoom','teams')
     OR NEW.status NOT IN ('attended','below_threshold','absent') THEN
    RETURN NEW;
  END IF;
  v_key := 'attendance:'||NEW.provider||':'||NEW.booking_type||':'||
    NEW.booking_id::text||':'||NEW.attendance_target_id::text||':'||
    NEW.outcome_revision_id::text;
  INSERT INTO event_cpd_badge_outbox(
    tenant_id,idempotency_key,booking_type,booking_id,trigger_type,
    evidence_type,evidence_id,evidence_snapshot
  ) VALUES (
    NEW.tenant_id,v_key,NEW.booking_type,NEW.booking_id,'attendance',
    NEW.provider,NEW.outcome_revision_id::text,
    jsonb_build_object(
      'type',NEW.provider,'finalized',true,'status',NEW.status,
      'transitionId',NEW.id,'revisionId',NEW.outcome_revision_id,
      'attendanceTargetId',NEW.attendance_target_id,
      'targetType',NEW.target_type,'targetId',NEW.target_id,
      'eventId',NEW.event_id,'memberId',NEW.member_id,'ticketId',NEW.ticket_id,
      'previousStatus',NEW.previous_status,'revision',NEW.revision_number,
      'durationSeconds',NEW.duration_seconds,'thresholdMinutes',NEW.threshold_minutes
    )
  ) ON CONFLICT (tenant_id,idempotency_key) DO NOTHING;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS enqueue_event_cpd_online_attendance ON public.attendance_outcome_transition;
CREATE TRIGGER enqueue_event_cpd_online_attendance
AFTER INSERT ON public.attendance_outcome_transition
FOR EACH ROW EXECUTE FUNCTION public.enqueue_event_cpd_from_attendance_transition();

CREATE OR REPLACE FUNCTION public.claim_event_cpd_badge_outbox(p_limit integer DEFAULT 25)
RETURNS SETOF public.event_cpd_badge_outbox LANGUAGE sql SECURITY DEFINER SET search_path=public AS $$
  WITH candidates AS (
    SELECT id FROM event_cpd_badge_outbox
    WHERE (status IN ('pending','retry') AND available_at<=now())
       OR (status='processing' AND locked_at<now()-interval '10 minutes')
    ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT LEAST(GREATEST(p_limit,1),100)
  )
  UPDATE event_cpd_badge_outbox o SET status='processing',attempts=attempts+1,
    locked_at=now(),lock_token=gen_random_uuid(),updated_at=now()
  FROM candidates c WHERE o.id=c.id RETURNING o.*;
$$;
CREATE OR REPLACE FUNCTION public.complete_event_cpd_badge_outbox(p_id uuid,p_lock_token uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
BEGIN
 UPDATE event_cpd_badge_outbox SET status='complete',locked_at=NULL,lock_token=NULL,last_error=NULL,updated_at=now()
 WHERE id=p_id AND status='processing' AND lock_token=p_lock_token; RETURN FOUND;
END $$;
CREATE OR REPLACE FUNCTION public.fail_event_cpd_badge_outbox(p_id uuid,p_lock_token uuid,p_error text,p_max_attempts integer DEFAULT 8)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
BEGIN
 UPDATE event_cpd_badge_outbox SET status=CASE WHEN attempts>=p_max_attempts THEN 'dead' ELSE 'retry' END,
 available_at=now()+make_interval(secs=>LEAST(3600,(power(2,LEAST(attempts,10))*15)::integer)),
 locked_at=NULL,lock_token=NULL,last_error=left(p_error,2000),updated_at=now()
 WHERE id=p_id AND status='processing' AND lock_token=p_lock_token; RETURN FOUND;
END $$;

ALTER TABLE public.event_cpd_badge_rule ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.event_cpd_badge_award_attempt ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.event_cpd_badge_outbox ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS service_role_all ON public.event_cpd_badge_rule;
CREATE POLICY service_role_all ON public.event_cpd_badge_rule FOR ALL TO service_role USING(true) WITH CHECK(true);
DROP POLICY IF EXISTS service_role_all ON public.event_cpd_badge_award_attempt;
CREATE POLICY service_role_all ON public.event_cpd_badge_award_attempt FOR ALL TO service_role USING(true) WITH CHECK(true);
DROP POLICY IF EXISTS service_role_all ON public.event_cpd_badge_outbox;
CREATE POLICY service_role_all ON public.event_cpd_badge_outbox FOR ALL TO service_role USING(true) WITH CHECK(true);
REVOKE ALL ON public.event_cpd_badge_rule,public.event_cpd_badge_award_attempt,public.event_cpd_badge_outbox FROM anon,authenticated;
REVOKE ALL ON FUNCTION public.claim_event_cpd_badge_outbox(integer) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.complete_event_cpd_badge_outbox(uuid,uuid) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.fail_event_cpd_badge_outbox(uuid,uuid,text,integer) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.replace_event_cpd_badge_rules(uuid,text,uuid,jsonb) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.enqueue_event_cpd_from_attendance_transition() FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.record_event_cpd_badge_award(jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.claim_event_cpd_badge_outbox(integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.complete_event_cpd_badge_outbox(uuid,uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.fail_event_cpd_badge_outbox(uuid,uuid,text,integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.replace_event_cpd_badge_rules(uuid,text,uuid,jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.record_event_cpd_badge_award(jsonb) TO service_role;