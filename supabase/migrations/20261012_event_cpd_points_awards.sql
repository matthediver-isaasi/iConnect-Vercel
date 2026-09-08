-- Task #4220: immutable event CPD points ledger, rules and reliable delivery.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE public.event_cpd_points_rule (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenant(id) ON DELETE CASCADE,
  event_type text NOT NULL CHECK (event_type IN ('event','complex_event')),
  event_id uuid NOT NULL,
  trigger_type text NOT NULL CHECK (trigger_type IN ('registration','attendance')),
  ticket_id text,
  ticket_name_snapshot text,
  points_value numeric(20,6),
  is_no_award boolean NOT NULL DEFAULT false,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  removed_at timestamptz,
  CHECK ((is_no_award AND ticket_id IS NOT NULL AND points_value IS NULL)
    OR (NOT is_no_award AND points_value IS NOT NULL AND points_value >= 0))
);
CREATE UNIQUE INDEX uq_event_cpd_points_rule_event ON public.event_cpd_points_rule
  (tenant_id,event_type,event_id) WHERE ticket_id IS NULL AND active;
CREATE UNIQUE INDEX uq_event_cpd_points_rule_ticket ON public.event_cpd_points_rule
  (tenant_id,event_type,event_id,ticket_id) WHERE ticket_id IS NOT NULL AND active;
CREATE INDEX idx_event_cpd_points_rule_resolve ON public.event_cpd_points_rule
  (tenant_id,event_type,event_id,ticket_id,trigger_type) WHERE active;

CREATE OR REPLACE FUNCTION public.validate_event_cpd_points_rule()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_ticket_name text;
BEGIN
  IF TG_OP='UPDATE' AND NOT NEW.active THEN
    IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
       OR NEW.event_type IS DISTINCT FROM OLD.event_type
       OR NEW.event_id IS DISTINCT FROM OLD.event_id THEN
      RAISE EXCEPTION 'archived CPD points rule identity cannot change';
    END IF;
    NEW.ticket_id:=OLD.ticket_id;
    NEW.ticket_name_snapshot:=OLD.ticket_name_snapshot;
    NEW.points_value:=OLD.points_value;
    NEW.is_no_award:=OLD.is_no_award;
    NEW.removed_at:=COALESCE(NEW.removed_at,now());
    NEW.updated_at:=now();
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
    IF NOT EXISTS (SELECT 1 FROM complex_event WHERE id=NEW.event_id AND tenant_id=NEW.tenant_id) THEN
      RAISE EXCEPTION 'complex event does not belong to tenant';
    END IF;
    IF NEW.ticket_id IS NOT NULL THEN
      SELECT name INTO v_ticket_name FROM complex_event_ticket_class
      WHERE id::text=NEW.ticket_id AND complex_event_id=NEW.event_id AND tenant_id=NEW.tenant_id;
      IF v_ticket_name IS NULL THEN RAISE EXCEPTION 'ticket does not belong to complex event and tenant'; END IF;
    END IF;
  END IF;
  IF NEW.is_no_award AND (NEW.ticket_id IS NULL OR NEW.points_value IS NOT NULL) THEN
    RAISE EXCEPTION 'no-award points rules must be ticket scoped and have no value';
  ELSIF NOT NEW.is_no_award AND (NEW.points_value IS NULL OR NEW.points_value < 0) THEN
    RAISE EXCEPTION 'CPD points must be non-negative';
  END IF;
  IF NEW.ticket_id IS NOT NULL THEN NEW.ticket_name_snapshot:=v_ticket_name; END IF;
  NEW.updated_at:=now();
  RETURN NEW;
END $$;
CREATE TRIGGER validate_event_cpd_points_rule
BEFORE INSERT OR UPDATE ON public.event_cpd_points_rule
FOR EACH ROW EXECUTE FUNCTION public.validate_event_cpd_points_rule();

CREATE OR REPLACE FUNCTION public.replace_event_cpd_points_rules(
  p_tenant_id uuid,p_event_type text,p_event_id uuid,p_rules jsonb
) RETURNS SETOF public.event_cpd_points_rule
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_rule jsonb;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'service_role is required'; END IF;
  IF p_tenant_id IS NULL OR p_event_type NOT IN ('event','complex_event') OR p_event_id IS NULL
     OR jsonb_typeof(p_rules)<>'array' THEN
    RAISE EXCEPTION 'tenant, event type, event and rules array are required';
  END IF;
  IF jsonb_array_length(p_rules)>501 THEN RAISE EXCEPTION 'at most 501 rules are allowed'; END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_rules) r
    WHERE r->>'trigger_type' NOT IN ('registration','attendance')
      OR r->>'trigger_type' IS NULL
      OR (r->>'ticket_id' IS NULL AND COALESCE((r->>'is_no_award')::boolean,false))
      OR (NOT COALESCE((r->>'is_no_award')::boolean,false) AND
          COALESCE(r->>'points_value','') !~ '^[0-9]{1,14}([.][0-9]{1,6})?$')
  ) THEN RAISE EXCEPTION 'invalid CPD points rule'; END IF;
  IF (SELECT count(*) FROM jsonb_array_elements(p_rules) r WHERE r->>'ticket_id' IS NULL)>1 THEN
    RAISE EXCEPTION 'only one event-wide points rule is allowed';
  END IF;
  IF EXISTS (
    SELECT ticket_id FROM jsonb_to_recordset(p_rules) AS r(ticket_id text)
    WHERE ticket_id IS NOT NULL GROUP BY ticket_id HAVING count(*)>1
  ) THEN RAISE EXCEPTION 'only one points override is allowed per ticket'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(
    p_tenant_id::text||':cpd-points:'||p_event_type||':'||p_event_id::text,0));
  UPDATE event_cpd_points_rule SET active=false,removed_at=now(),updated_at=now()
    WHERE tenant_id=p_tenant_id AND event_type=p_event_type AND event_id=p_event_id AND active;
  FOR v_rule IN SELECT value FROM jsonb_array_elements(p_rules) LOOP
    INSERT INTO event_cpd_points_rule(
      tenant_id,event_type,event_id,trigger_type,ticket_id,ticket_name_snapshot,
      points_value,is_no_award
    ) VALUES (
      p_tenant_id,p_event_type,p_event_id,v_rule->>'trigger_type',
      NULLIF(v_rule->>'ticket_id',''),NULLIF(v_rule->>'ticket_name_snapshot',''),
      CASE WHEN COALESCE((v_rule->>'is_no_award')::boolean,false) THEN NULL
        ELSE (v_rule->>'points_value')::numeric END,
      COALESCE((v_rule->>'is_no_award')::boolean,false)
    );
  END LOOP;
  RETURN QUERY SELECT * FROM event_cpd_points_rule
    WHERE tenant_id=p_tenant_id AND event_type=p_event_type AND event_id=p_event_id AND active
    ORDER BY created_at,id;
END $$;

-- This append-only table, not a mutable balance, is the points authority.
CREATE TABLE public.member_cpd_points_ledger (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenant(id) ON DELETE RESTRICT,
  member_id uuid NOT NULL REFERENCES public.member(id) ON DELETE RESTRICT,
  entry_kind text NOT NULL CHECK (entry_kind IN ('event_award','reversal')),
  points_value numeric(20,6) NOT NULL,
  event_type text NOT NULL CHECK (event_type IN ('event','complex_event')),
  event_id uuid NOT NULL,
  booking_type text NOT NULL CHECK (booking_type IN ('booking','complex_event_booking')),
  booking_id uuid NOT NULL,
  ticket_id text,
  ticket_name_snapshot text,
  award_trigger text NOT NULL CHECK (award_trigger IN ('registration','attendance')),
  evidence_type text,
  evidence_id text,
  evidence_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  rule_id uuid REFERENCES public.event_cpd_points_rule(id) ON DELETE RESTRICT,
  rule_snapshot jsonb NOT NULL,
  occurrence_key text NOT NULL,
  reversal_of uuid REFERENCES public.member_cpd_points_ledger(id) ON DELETE RESTRICT,
  reason text,
  created_by text NOT NULL DEFAULT 'system:event-cpd-points',
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((entry_kind='event_award' AND points_value>=0 AND reversal_of IS NULL)
    OR (entry_kind='reversal' AND points_value<=0 AND reversal_of IS NOT NULL))
);
CREATE UNIQUE INDEX uq_member_cpd_points_event_occurrence ON public.member_cpd_points_ledger
  (tenant_id,occurrence_key) WHERE entry_kind='event_award';
CREATE UNIQUE INDEX uq_member_cpd_points_reversal ON public.member_cpd_points_ledger(reversal_of)
  WHERE entry_kind='reversal';
CREATE INDEX idx_member_cpd_points_history ON public.member_cpd_points_ledger
  (tenant_id,member_id,created_at,id);

CREATE OR REPLACE FUNCTION public.protect_member_cpd_points_ledger()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'CPD points ledger entries are immutable'; END $$;
CREATE TRIGGER protect_member_cpd_points_ledger
BEFORE UPDATE OR DELETE ON public.member_cpd_points_ledger
FOR EACH ROW EXECUTE FUNCTION public.protect_member_cpd_points_ledger();

CREATE TABLE public.event_cpd_points_award_attempt (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenant(id) ON DELETE CASCADE,
  idempotency_key text NOT NULL,
  event_type text CHECK (event_type IN ('event','complex_event')),
  event_id uuid,
  booking_type text NOT NULL CHECK (booking_type IN ('booking','complex_event_booking')),
  booking_id uuid NOT NULL,
  member_id uuid,
  ticket_id text,
  ticket_name_snapshot text,
  trigger_type text NOT NULL CHECK (trigger_type IN ('registration','attendance')),
  evidence_type text,
  evidence_id text,
  evidence_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  rule_id uuid REFERENCES public.event_cpd_points_rule(id) ON DELETE SET NULL,
  points_value numeric(20,6),
  ledger_entry_id uuid REFERENCES public.member_cpd_points_ledger(id) ON DELETE SET NULL,
  status text NOT NULL CHECK (status IN (
    'awarded','already_awarded','skipped_cancelled','skipped_unmatched',
    'skipped_cross_tenant','skipped_no_rule','skipped_not_qualifying',
    'pending_evidence','error'
  )),
  detail text,
  delivery_attempt integer NOT NULL DEFAULT 1 CHECK (delivery_attempt > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(tenant_id,idempotency_key,delivery_attempt)
);

CREATE TABLE public.event_cpd_points_followup (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenant(id) ON DELETE CASCADE,
  ledger_entry_id uuid NOT NULL REFERENCES public.member_cpd_points_ledger(id) ON DELETE RESTRICT,
  action text NOT NULL CHECK (action IN ('reversal')),
  policy text NOT NULL CHECK (policy IN (
    'booking_cancellation','qr_reversal','attendance_downgrade','manual'
  )),
  status text NOT NULL CHECK (status IN ('completed','already_completed','error')),
  reason text,
  actor text NOT NULL,
  result_ledger_entry_id uuid REFERENCES public.member_cpd_points_ledger(id) ON DELETE RESTRICT,
  provenance jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER protect_event_cpd_points_attempt
BEFORE UPDATE OR DELETE ON public.event_cpd_points_award_attempt
FOR EACH ROW EXECUTE FUNCTION public.protect_member_cpd_points_ledger();
CREATE TRIGGER protect_event_cpd_points_followup
BEFORE UPDATE OR DELETE ON public.event_cpd_points_followup
FOR EACH ROW EXECUTE FUNCTION public.protect_member_cpd_points_ledger();

CREATE TABLE public.event_cpd_points_outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenant(id) ON DELETE CASCADE,
  idempotency_key text NOT NULL,
  booking_type text NOT NULL CHECK (booking_type IN ('booking','complex_event_booking')),
  booking_id uuid NOT NULL,
  trigger_type text NOT NULL CHECK (trigger_type IN ('registration','attendance')),
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
  UNIQUE(tenant_id,idempotency_key)
);
CREATE INDEX idx_event_cpd_points_outbox_ready ON public.event_cpd_points_outbox(status,available_at,created_at)
  WHERE status IN ('pending','retry','processing');

CREATE TABLE public.event_cpd_points_replay (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES public.tenant(id) ON DELETE CASCADE,
  event_type text NOT NULL CHECK (event_type IN ('event','complex_event')),
  event_id uuid NOT NULL,
  trigger_type text NOT NULL CHECK (trigger_type IN ('registration','attendance')),
  booking_ids uuid[],
  reason text NOT NULL,
  requested_by text NOT NULL,
  enqueued_count integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION public.record_event_cpd_points_award(p_attempt jsonb)
RETURNS public.event_cpd_points_award_attempt
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE
  v_tenant uuid:=(p_attempt->>'tenant_id')::uuid;
  v_key text:=p_attempt->>'idempotency_key';
  v_booking_type text:=p_attempt->>'booking_type';
  v_booking_id uuid:=(p_attempt->>'booking_id')::uuid;
  v_event_type text:=p_attempt->>'event_type';
  v_event_id uuid;
  v_status text:=p_attempt->>'status';
  v_booking_status text; v_email text; v_ticket text; v_ticket_name text;
  v_member uuid:=NULLIF(p_attempt->>'member_id','')::uuid;
  v_rule event_cpd_points_rule%ROWTYPE;
  v_ledger uuid; v_occurrence text;
  v_evidence jsonb:=COALESCE(p_attempt->'evidence_snapshot','{}'::jsonb);
  v_checked timestamptz; v_reversed timestamptz; v_queued timestamptz;
  v_current_status text; v_current_revision uuid;
  v_delivery_attempt integer;
  v_result event_cpd_points_award_attempt%ROWTYPE;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'service_role is required'; END IF;
  IF v_tenant IS NULL OR NULLIF(v_key,'') IS NULL
     OR v_booking_type NOT IN ('booking','complex_event_booking') THEN
    RAISE EXCEPTION 'invalid CPD points attempt';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(v_tenant::text||':cpd-points-attempt:'||v_key,0));
  SELECT * INTO v_result FROM event_cpd_points_award_attempt
    WHERE tenant_id=v_tenant AND idempotency_key=v_key
      AND status NOT IN ('pending_evidence','error')
    ORDER BY delivery_attempt DESC LIMIT 1;
  IF FOUND THEN RETURN v_result; END IF;
  SELECT COALESCE(max(delivery_attempt),0)+1 INTO v_delivery_attempt
  FROM event_cpd_points_award_attempt
  WHERE tenant_id=v_tenant AND idempotency_key=v_key;

  IF v_booking_type='booking' THEN
    SELECT event_id,status,attendee_email,ticket_class_id,ticket_class_name,checked_in_at,check_in_reversed_at
      INTO v_event_id,v_booking_status,v_email,v_ticket,v_ticket_name,v_checked,v_reversed
    FROM booking WHERE id=v_booking_id AND tenant_id=v_tenant FOR UPDATE;
  ELSE
    SELECT event_id,status,attendee_email,ticket_class_id,ticket_class_name
      INTO v_event_id,v_booking_status,v_email,v_ticket,v_ticket_name
    FROM complex_event_booking WHERE id=v_booking_id AND tenant_id=v_tenant FOR UPDATE;
  END IF;
  IF v_event_id IS NULL THEN
    v_status:=CASE WHEN (v_booking_type='booking' AND EXISTS(SELECT 1 FROM booking WHERE id=v_booking_id))
      OR (v_booking_type='complex_event_booking' AND EXISTS(SELECT 1 FROM complex_event_booking WHERE id=v_booking_id))
      THEN 'skipped_cross_tenant' ELSE 'error' END;
    v_event_id:=NULLIF(p_attempt->>'event_id','')::uuid;
  ELSE
    IF (v_booking_type='booking' AND v_event_type IS DISTINCT FROM 'event')
       OR (v_booking_type='complex_event_booking' AND v_event_type IS DISTINCT FROM 'complex_event') THEN
      v_status:='skipped_cross_tenant';
    END IF;
    PERFORM pg_advisory_xact_lock(hashtextextended(
      v_tenant::text||':cpd-points:'||v_event_type||':'||v_event_id::text,0));
  END IF;
  IF v_status='awarded' AND v_booking_status<>'confirmed' THEN v_status:='skipped_cancelled'; END IF;
  IF v_status='awarded' AND (v_member IS NULL OR NOT EXISTS (
    SELECT 1 FROM member WHERE id=v_member AND tenant_id=v_tenant
      AND lower(trim(email))=lower(trim(v_email))
  )) THEN v_status:='skipped_unmatched'; END IF;

  IF v_status='awarded' AND p_attempt->>'trigger_type'='attendance' THEN
    IF p_attempt->>'evidence_type'='qr_checkin' THEN
      BEGIN v_queued:=NULLIF(v_evidence->>'checkedInAt','')::timestamptz;
      EXCEPTION WHEN OTHERS THEN v_queued:=NULL; END;
      IF v_booking_type='complex_event_booking' THEN
        SELECT c.checked_in_at,c.check_in_reversed_at INTO v_checked,v_reversed
        FROM complex_event_session_checkin c
        JOIN complex_event_session s ON s.id=c.session_id AND s.tenant_id=c.tenant_id
          AND s.complex_event_id=c.complex_event_id
        WHERE c.id::text=p_attempt->>'evidence_id' AND c.tenant_id=v_tenant
          AND c.booking_id=v_booking_id AND c.complex_event_id=v_event_id FOR UPDATE OF c;
      ELSIF p_attempt->>'evidence_id' IS DISTINCT FROM v_booking_id::text THEN
        v_checked:=NULL;
      END IF;
      IF v_checked IS NULL OR v_queued IS NULL OR v_checked IS DISTINCT FROM v_queued
         OR (v_reversed IS NOT NULL AND v_checked<=v_reversed) THEN
        v_status:='skipped_not_qualifying';
      END IF;
    ELSIF p_attempt->>'evidence_type' IN ('zoom','teams') THEN
      SELECT status,outcome_revision_id INTO v_current_status,v_current_revision
      FROM attendance_current_outcome
      WHERE tenant_id=v_tenant AND provider=(p_attempt->>'evidence_type')
        AND attendance_target_id::text=(v_evidence->>'attendanceTargetId')
        AND booking_type=v_booking_type AND booking_id=v_booking_id FOR UPDATE;
      IF v_current_status IS NULL OR v_current_status IN ('pending','error','unmatched') THEN
        v_status:='pending_evidence';
      ELSIF v_current_status<>'attended' OR (v_evidence->>'status')<>'attended'
        OR v_current_revision::text IS DISTINCT FROM (v_evidence->>'revisionId') THEN
        v_status:='skipped_not_qualifying';
      END IF;
    ELSE
      v_status:='pending_evidence';
    END IF;
  END IF;

  IF v_status='awarded' THEN
    SELECT * INTO v_rule FROM event_cpd_points_rule r
    WHERE r.tenant_id=v_tenant AND r.event_type=v_event_type AND r.event_id=v_event_id AND r.active
      AND (r.ticket_id=v_ticket OR (r.ticket_id IS NULL
        AND NOT EXISTS (SELECT 1 FROM event_cpd_points_rule x
          WHERE x.tenant_id=v_tenant AND x.event_type=v_event_type AND x.event_id=v_event_id
            AND x.active AND x.ticket_id=v_ticket)))
    ORDER BY (r.ticket_id IS NOT NULL) DESC LIMIT 1;
    IF v_rule.id IS NULL OR v_rule.is_no_award
       OR v_rule.trigger_type IS DISTINCT FROM p_attempt->>'trigger_type' THEN
      v_status:='skipped_no_rule';
    END IF;
  END IF;

  IF v_status='awarded' THEN
    v_occurrence:=v_event_type||':'||v_event_id||':'||v_booking_type||':'||v_booking_id||':'||(p_attempt->>'trigger_type');
    SELECT id INTO v_ledger FROM member_cpd_points_ledger
      WHERE tenant_id=v_tenant AND occurrence_key=v_occurrence AND entry_kind='event_award';
    IF v_ledger IS NOT NULL THEN
      v_status:='already_awarded';
    ELSE
      INSERT INTO member_cpd_points_ledger(
        tenant_id,member_id,entry_kind,points_value,event_type,event_id,booking_type,booking_id,
        ticket_id,ticket_name_snapshot,award_trigger,evidence_type,evidence_id,evidence_snapshot,
        rule_id,rule_snapshot,occurrence_key
      ) VALUES (
        v_tenant,v_member,'event_award',v_rule.points_value,v_event_type,v_event_id,v_booking_type,v_booking_id,
        v_ticket,COALESCE(v_ticket_name,p_attempt->>'ticket_name_snapshot'),p_attempt->>'trigger_type',
        NULLIF(p_attempt->>'evidence_type',''),NULLIF(p_attempt->>'evidence_id',''),v_evidence,
        v_rule.id,jsonb_build_object(
          'ruleId',v_rule.id,'pointsValue',v_rule.points_value,'triggerType',v_rule.trigger_type,
          'ticketId',v_rule.ticket_id,'ticketName',v_rule.ticket_name_snapshot,
          'configuredAt',v_rule.created_at
        ),v_occurrence
      ) RETURNING id INTO v_ledger;
    END IF;
  END IF;

  INSERT INTO event_cpd_points_award_attempt(
    tenant_id,idempotency_key,event_type,event_id,booking_type,booking_id,member_id,
    ticket_id,ticket_name_snapshot,trigger_type,evidence_type,evidence_id,evidence_snapshot,
    rule_id,points_value,ledger_entry_id,status,detail,delivery_attempt
  ) VALUES (
    v_tenant,v_key,v_event_type,v_event_id,v_booking_type,v_booking_id,v_member,
    v_ticket,COALESCE(v_ticket_name,p_attempt->>'ticket_name_snapshot'),p_attempt->>'trigger_type',
    NULLIF(p_attempt->>'evidence_type',''),NULLIF(p_attempt->>'evidence_id',''),v_evidence,
    v_rule.id,v_rule.points_value,v_ledger,v_status,NULLIF(p_attempt->>'detail',''),
    v_delivery_attempt
  ) RETURNING * INTO v_result;
  RETURN v_result;
END $$;

CREATE OR REPLACE FUNCTION public.append_event_cpd_points_reversal(
  p_tenant_id uuid,p_ledger_entry_id uuid,p_policy text,p_reason text,p_actor text,
  p_provenance jsonb DEFAULT '{}'::jsonb
) RETURNS public.event_cpd_points_followup
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_award member_cpd_points_ledger%ROWTYPE; v_reversal uuid; v_result event_cpd_points_followup%ROWTYPE;
BEGIN
  IF p_policy NOT IN ('booking_cancellation','qr_reversal','attendance_downgrade','manual') THEN
    RAISE EXCEPTION 'valid CPD points reversal policy is required';
  END IF;
  IF NULLIF(trim(p_reason),'') IS NULL OR NULLIF(trim(p_actor),'') IS NULL THEN
    RAISE EXCEPTION 'reversal reason and actor are required';
  END IF;
  SELECT * INTO v_award FROM member_cpd_points_ledger
    WHERE id=p_ledger_entry_id AND tenant_id=p_tenant_id AND entry_kind='event_award' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'tenant CPD points award not found'; END IF;
  SELECT id INTO v_reversal FROM member_cpd_points_ledger WHERE reversal_of=v_award.id;
  IF v_reversal IS NULL THEN
    INSERT INTO member_cpd_points_ledger(
      tenant_id,member_id,entry_kind,points_value,event_type,event_id,booking_type,booking_id,
      ticket_id,ticket_name_snapshot,award_trigger,evidence_type,evidence_id,evidence_snapshot,
      rule_id,rule_snapshot,occurrence_key,reversal_of,reason,created_by
    ) VALUES (
      v_award.tenant_id,v_award.member_id,'reversal',-v_award.points_value,v_award.event_type,
      v_award.event_id,v_award.booking_type,v_award.booking_id,v_award.ticket_id,
      v_award.ticket_name_snapshot,v_award.award_trigger,'reversal',v_award.id::text,
      COALESCE(p_provenance,'{}'),v_award.rule_id,v_award.rule_snapshot,
      'reversal:'||v_award.id,v_award.id,p_reason,p_actor
    ) RETURNING id INTO v_reversal;
  END IF;
  INSERT INTO event_cpd_points_followup(
    tenant_id,ledger_entry_id,action,policy,status,reason,actor,result_ledger_entry_id,provenance
  ) VALUES (
    p_tenant_id,v_award.id,'reversal',p_policy,
    CASE WHEN EXISTS(SELECT 1 FROM event_cpd_points_followup WHERE ledger_entry_id=v_award.id AND status='completed')
      THEN 'already_completed' ELSE 'completed' END,
    p_reason,p_actor,v_reversal,COALESCE(p_provenance,'{}')
  ) RETURNING * INTO v_result;
  RETURN v_result;
END $$;

CREATE OR REPLACE FUNCTION public.reverse_event_cpd_points_award(
  p_tenant_id uuid,p_ledger_entry_id uuid,p_reason text,p_actor text,p_provenance jsonb DEFAULT '{}'::jsonb
) RETURNS public.event_cpd_points_followup
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'service_role is required'; END IF;
  RETURN public.append_event_cpd_points_reversal(
    p_tenant_id,p_ledger_entry_id,'manual',p_reason,p_actor,p_provenance
  );
END $$;

-- Fixed automatic reversal policy: cancellation reverses every award for that
-- booking; QR reversal reverses awards sourced from that check-in generation;
-- an online downgrade reverses the event attendance award for that booking.
-- Reconfirmation or later evidence may be processed again, but occurrence
-- uniqueness means it can never append a second positive award.
CREATE OR REPLACE FUNCTION public.followup_event_cpd_points_booking()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_award record; v_type text;
BEGIN
  IF OLD.status='confirmed' AND NEW.status='cancelled' THEN
    v_type:=CASE TG_TABLE_NAME WHEN 'booking' THEN 'booking' ELSE 'complex_event_booking' END;
    FOR v_award IN SELECT id FROM member_cpd_points_ledger
      WHERE tenant_id=NEW.tenant_id AND booking_type=v_type AND booking_id=NEW.id
        AND entry_kind='event_award'
    LOOP
      PERFORM public.append_event_cpd_points_reversal(
        NEW.tenant_id,v_award.id,'booking_cancellation','booking no longer confirmed',
        'system:event-cpd-points:cancellation',jsonb_build_object('newStatus',NEW.status)
      );
    END LOOP;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER followup_event_cpd_points_booking AFTER UPDATE OF status ON public.booking
FOR EACH ROW EXECUTE FUNCTION public.followup_event_cpd_points_booking();
CREATE TRIGGER followup_event_cpd_points_complex_booking AFTER UPDATE OF status ON public.complex_event_booking
FOR EACH ROW EXECUTE FUNCTION public.followup_event_cpd_points_booking();

CREATE OR REPLACE FUNCTION public.followup_event_cpd_points_qr_reversal()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_award record; v_evidence text; v_type text; v_booking uuid;
BEGIN
  IF NEW.check_in_reversed_at IS NOT NULL
     AND NEW.check_in_reversed_at IS DISTINCT FROM OLD.check_in_reversed_at THEN
    IF TG_TABLE_NAME='booking' THEN
      v_type:='booking'; v_booking:=NEW.id;
    ELSE
      v_type:='complex_event_booking'; v_booking:=NEW.booking_id;
    END IF;
    v_evidence:=NEW.id::text;
    FOR v_award IN SELECT id FROM member_cpd_points_ledger
      WHERE tenant_id=NEW.tenant_id AND booking_type=v_type
        AND booking_id=v_booking
        AND entry_kind='event_award' AND award_trigger='attendance'
        AND evidence_type='qr_checkin' AND evidence_id=v_evidence
    LOOP
      PERFORM public.append_event_cpd_points_reversal(
        NEW.tenant_id,v_award.id,'qr_reversal','qualifying QR check-in reversed',
        'system:event-cpd-points:qr-reversal',
        jsonb_build_object('reversedAt',NEW.check_in_reversed_at,
          'reason',NEW.check_in_reversal_reason)
      );
    END LOOP;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER followup_event_cpd_points_simple_qr AFTER UPDATE OF check_in_reversed_at ON public.booking
FOR EACH ROW EXECUTE FUNCTION public.followup_event_cpd_points_qr_reversal();
CREATE TRIGGER followup_event_cpd_points_complex_qr AFTER UPDATE OF check_in_reversed_at ON public.complex_event_session_checkin
FOR EACH ROW EXECUTE FUNCTION public.followup_event_cpd_points_qr_reversal();

CREATE OR REPLACE FUNCTION public.followup_event_cpd_points_online_downgrade()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_award record;
BEGIN
  IF NEW.provider IN ('zoom','teams') AND NEW.status IN ('below_threshold','absent')
     AND NEW.previous_status='attended' THEN
    FOR v_award IN SELECT id FROM member_cpd_points_ledger
      WHERE tenant_id=NEW.tenant_id AND booking_type=NEW.booking_type
        AND booking_id=NEW.booking_id AND entry_kind='event_award'
        AND award_trigger='attendance' AND evidence_type=NEW.provider
        AND evidence_snapshot->>'attendanceTargetId'=NEW.attendance_target_id::text
    LOOP
      PERFORM public.append_event_cpd_points_reversal(
        NEW.tenant_id,v_award.id,'attendance_downgrade','attendance outcome downgraded',
        'system:event-cpd-points:attendance-downgrade',
        jsonb_build_object('transitionId',NEW.id,'previousStatus',NEW.previous_status,
          'status',NEW.status,'revisionId',NEW.outcome_revision_id)
      );
    END LOOP;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER followup_event_cpd_points_online_downgrade
AFTER INSERT ON public.attendance_outcome_transition
FOR EACH ROW EXECUTE FUNCTION public.followup_event_cpd_points_online_downgrade();

CREATE OR REPLACE FUNCTION public.enqueue_event_cpd_points_from_booking()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_type text; v_key text;
BEGIN
  IF NEW.status='confirmed' AND (TG_OP='INSERT' OR OLD.status IS DISTINCT FROM NEW.status) THEN
    v_type:=CASE TG_TABLE_NAME WHEN 'booking' THEN 'booking' ELSE 'complex_event_booking' END;
    v_key:='registration:'||v_type||':'||NEW.id||':'||clock_timestamp()::text;
    INSERT INTO event_cpd_points_outbox(tenant_id,idempotency_key,booking_type,booking_id,trigger_type,evidence_type,evidence_id)
    VALUES(NEW.tenant_id,v_key,v_type,NEW.id,'registration','confirmed_booking',NEW.id::text)
    ON CONFLICT(tenant_id,idempotency_key) DO NOTHING;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER enqueue_event_cpd_points_booking AFTER INSERT OR UPDATE OF status ON public.booking
FOR EACH ROW EXECUTE FUNCTION public.enqueue_event_cpd_points_from_booking();
CREATE TRIGGER enqueue_event_cpd_points_complex_booking AFTER INSERT OR UPDATE OF status ON public.complex_event_booking
FOR EACH ROW EXECUTE FUNCTION public.enqueue_event_cpd_points_from_booking();

CREATE OR REPLACE FUNCTION public.enqueue_event_cpd_points_from_checkin()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_booking uuid; v_tenant uuid; v_type text; v_evidence text; v_snapshot jsonb; v_key text;
BEGIN
  IF NEW.checked_in_at IS NOT NULL AND (TG_OP='INSERT' OR OLD.checked_in_at IS NULL) THEN
    IF TG_TABLE_NAME='booking' THEN
      v_booking:=NEW.id; v_tenant:=NEW.tenant_id; v_type:='booking'; v_evidence:=NEW.id::text;
      v_snapshot:=jsonb_build_object('checkedInAt',NEW.checked_in_at,'checkInReversedAt',NEW.check_in_reversed_at);
    ELSE
      IF NOT EXISTS (
        SELECT 1 FROM complex_event_booking b JOIN complex_event_session s
          ON s.id=NEW.session_id AND s.tenant_id=NEW.tenant_id AND s.complex_event_id=NEW.complex_event_id
        WHERE b.id=NEW.booking_id AND b.tenant_id=NEW.tenant_id AND b.event_id=NEW.complex_event_id
      ) THEN RAISE EXCEPTION 'complex check-in does not match tenant event booking and session'; END IF;
      v_booking:=NEW.booking_id; v_tenant:=NEW.tenant_id; v_type:='complex_event_booking'; v_evidence:=NEW.id::text;
      v_snapshot:=jsonb_build_object('checkedInAt',NEW.checked_in_at,'checkInReversedAt',NEW.check_in_reversed_at,
        'sessionId',NEW.session_id,'complexEventId',NEW.complex_event_id);
    END IF;
    v_key:='attendance:qr:'||v_type||':'||v_evidence||':'||NEW.checked_in_at::text;
    INSERT INTO event_cpd_points_outbox(tenant_id,idempotency_key,booking_type,booking_id,trigger_type,evidence_type,evidence_id,evidence_snapshot)
    VALUES(v_tenant,v_key,v_type,v_booking,'attendance','qr_checkin',v_evidence,v_snapshot)
    ON CONFLICT(tenant_id,idempotency_key) DO NOTHING;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER enqueue_event_cpd_points_simple_checkin AFTER INSERT OR UPDATE OF checked_in_at ON public.booking
FOR EACH ROW EXECUTE FUNCTION public.enqueue_event_cpd_points_from_checkin();
CREATE TRIGGER enqueue_event_cpd_points_complex_checkin AFTER INSERT OR UPDATE OF checked_in_at ON public.complex_event_session_checkin
FOR EACH ROW EXECUTE FUNCTION public.enqueue_event_cpd_points_from_checkin();

CREATE OR REPLACE FUNCTION public.enqueue_event_cpd_points_from_attendance()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_key text;
BEGIN
  IF NEW.provider NOT IN ('zoom','teams') OR NEW.status NOT IN ('attended','below_threshold','absent') THEN RETURN NEW; END IF;
  v_key:='attendance:'||NEW.provider||':'||NEW.booking_type||':'||NEW.booking_id||':'||
    NEW.attendance_target_id||':'||NEW.outcome_revision_id;
  INSERT INTO event_cpd_points_outbox(
    tenant_id,idempotency_key,booking_type,booking_id,trigger_type,evidence_type,evidence_id,evidence_snapshot
  ) VALUES (
    NEW.tenant_id,v_key,NEW.booking_type,NEW.booking_id,'attendance',NEW.provider,NEW.outcome_revision_id::text,
    jsonb_build_object('type',NEW.provider,'finalized',true,'status',NEW.status,
      'transitionId',NEW.id,'revisionId',NEW.outcome_revision_id,
      'attendanceTargetId',NEW.attendance_target_id,'targetType',NEW.target_type,
      'targetId',NEW.target_id,'eventId',NEW.event_id,'memberId',NEW.member_id,
      'ticketId',NEW.ticket_id,'previousStatus',NEW.previous_status,
      'revision',NEW.revision_number,'durationSeconds',NEW.duration_seconds,
      'thresholdMinutes',NEW.threshold_minutes)
  ) ON CONFLICT(tenant_id,idempotency_key) DO NOTHING;
  RETURN NEW;
END $$;
CREATE TRIGGER enqueue_event_cpd_points_online_attendance AFTER INSERT ON public.attendance_outcome_transition
FOR EACH ROW EXECUTE FUNCTION public.enqueue_event_cpd_points_from_attendance();

CREATE OR REPLACE FUNCTION public.claim_event_cpd_points_outbox(p_limit integer DEFAULT 25)
RETURNS SETOF public.event_cpd_points_outbox LANGUAGE sql SECURITY DEFINER SET search_path=public AS $$
  WITH candidates AS (
    SELECT id FROM event_cpd_points_outbox
    WHERE (status IN ('pending','retry') AND available_at<=now())
      OR (status='processing' AND locked_at<now()-interval '10 minutes')
    ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT LEAST(GREATEST(p_limit,1),100)
  )
  UPDATE event_cpd_points_outbox o SET status='processing',attempts=attempts+1,
    locked_at=now(),lock_token=gen_random_uuid(),updated_at=now()
  FROM candidates c WHERE o.id=c.id RETURNING o.*;
$$;
CREATE OR REPLACE FUNCTION public.complete_event_cpd_points_outbox(p_id uuid,p_lock_token uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
BEGIN
  UPDATE event_cpd_points_outbox SET status='complete',locked_at=NULL,lock_token=NULL,last_error=NULL,updated_at=now()
  WHERE id=p_id AND status='processing' AND lock_token=p_lock_token;
  RETURN FOUND;
END $$;
CREATE OR REPLACE FUNCTION public.fail_event_cpd_points_outbox(p_id uuid,p_lock_token uuid,p_error text,p_max_attempts integer DEFAULT 8)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
BEGIN
  UPDATE event_cpd_points_outbox SET status=CASE WHEN attempts>=p_max_attempts THEN 'dead' ELSE 'retry' END,
    available_at=now()+make_interval(secs=>LEAST(3600,(power(2,LEAST(attempts,10))*15)::integer)),
    locked_at=NULL,lock_token=NULL,last_error=left(p_error,2000),updated_at=now()
  WHERE id=p_id AND status='processing' AND lock_token=p_lock_token;
  RETURN FOUND;
END $$;

CREATE OR REPLACE FUNCTION public.enqueue_event_cpd_points_replay(
  p_tenant_id uuid,p_event_type text,p_event_id uuid,p_trigger_type text,
  p_replay_id uuid,p_booking_ids uuid[],p_reason text,p_actor text
) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_count integer:=0; v_added integer:=0;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'service_role is required'; END IF;
  IF p_tenant_id IS NULL OR p_event_type NOT IN ('event','complex_event')
     OR p_event_id IS NULL OR p_trigger_type NOT IN ('registration','attendance')
     OR p_replay_id IS NULL THEN RAISE EXCEPTION 'complete replay scope is required'; END IF;
  IF NULLIF(trim(p_reason),'') IS NULL OR NULLIF(trim(p_actor),'') IS NULL THEN
    RAISE EXCEPTION 'replay reason and actor are required';
  END IF;
  SELECT enqueued_count INTO v_count FROM event_cpd_points_replay
    WHERE id=p_replay_id AND tenant_id=p_tenant_id AND event_type=p_event_type
      AND event_id=p_event_id AND trigger_type=p_trigger_type;
  IF FOUND THEN RETURN v_count; END IF;
  IF p_event_type='event' AND NOT EXISTS (
    SELECT 1 FROM event WHERE id=p_event_id AND tenant_id=p_tenant_id
  ) THEN RAISE EXCEPTION 'event does not belong to tenant';
  ELSIF p_event_type='complex_event' AND NOT EXISTS (
    SELECT 1 FROM complex_event WHERE id=p_event_id AND tenant_id=p_tenant_id
  ) THEN RAISE EXCEPTION 'complex event does not belong to tenant'; END IF;
  INSERT INTO event_cpd_points_replay(
    id,tenant_id,event_type,event_id,trigger_type,booking_ids,reason,requested_by
  ) VALUES (
    p_replay_id,p_tenant_id,p_event_type,p_event_id,p_trigger_type,p_booking_ids,p_reason,p_actor
  );

  IF p_trigger_type='registration' THEN
    IF p_event_type='event' THEN
      INSERT INTO event_cpd_points_outbox(
        tenant_id,idempotency_key,booking_type,booking_id,trigger_type,evidence_type,evidence_id
      )
      SELECT p_tenant_id,'replay:'||p_replay_id||':registration:booking:'||b.id,
        'booking',b.id,'registration','confirmed_booking',b.id::text
      FROM booking b WHERE b.tenant_id=p_tenant_id AND b.event_id=p_event_id
        AND b.status='confirmed' AND (p_booking_ids IS NULL OR b.id=ANY(p_booking_ids))
      ON CONFLICT(tenant_id,idempotency_key) DO NOTHING;
    ELSE
      INSERT INTO event_cpd_points_outbox(
        tenant_id,idempotency_key,booking_type,booking_id,trigger_type,evidence_type,evidence_id
      )
      SELECT p_tenant_id,'replay:'||p_replay_id||':registration:complex_event_booking:'||b.id,
        'complex_event_booking',b.id,'registration','confirmed_booking',b.id::text
      FROM complex_event_booking b WHERE b.tenant_id=p_tenant_id AND b.event_id=p_event_id
        AND b.status='confirmed' AND (p_booking_ids IS NULL OR b.id=ANY(p_booking_ids))
      ON CONFLICT(tenant_id,idempotency_key) DO NOTHING;
    END IF;
    GET DIAGNOSTICS v_count=ROW_COUNT;
    UPDATE event_cpd_points_replay SET enqueued_count=v_count WHERE id=p_replay_id;
    RETURN v_count;
  END IF;

  IF p_event_type='event' THEN
    INSERT INTO event_cpd_points_outbox(
      tenant_id,idempotency_key,booking_type,booking_id,trigger_type,evidence_type,evidence_id,evidence_snapshot
    )
    SELECT p_tenant_id,'replay:'||p_replay_id||':attendance:qr:booking:'||b.id,
      'booking',b.id,'attendance','qr_checkin',b.id::text,
      jsonb_build_object('type','qr_checkin','checkedInAt',b.checked_in_at,
        'checkInReversedAt',b.check_in_reversed_at,'replayId',p_replay_id)
    FROM booking b WHERE b.tenant_id=p_tenant_id AND b.event_id=p_event_id
      AND b.status='confirmed' AND b.checked_in_at IS NOT NULL
      AND (b.check_in_reversed_at IS NULL OR b.checked_in_at>b.check_in_reversed_at)
      AND (p_booking_ids IS NULL OR b.id=ANY(p_booking_ids))
    ON CONFLICT(tenant_id,idempotency_key) DO NOTHING;
  ELSE
    INSERT INTO event_cpd_points_outbox(
      tenant_id,idempotency_key,booking_type,booking_id,trigger_type,evidence_type,evidence_id,evidence_snapshot
    )
    SELECT p_tenant_id,'replay:'||p_replay_id||':attendance:qr:complex_event_booking:'||c.id,
      'complex_event_booking',b.id,'attendance','qr_checkin',c.id::text,
      jsonb_build_object('type','qr_checkin','checkedInAt',c.checked_in_at,
        'checkInReversedAt',c.check_in_reversed_at,'sessionId',c.session_id,'replayId',p_replay_id)
    FROM complex_event_session_checkin c
    JOIN complex_event_booking b ON b.id=c.booking_id AND b.tenant_id=c.tenant_id
      AND b.event_id=c.complex_event_id
    WHERE c.tenant_id=p_tenant_id AND c.complex_event_id=p_event_id
      AND b.status='confirmed' AND c.checked_in_at IS NOT NULL
      AND (c.check_in_reversed_at IS NULL OR c.checked_in_at>c.check_in_reversed_at)
      AND (p_booking_ids IS NULL OR b.id=ANY(p_booking_ids))
    ON CONFLICT(tenant_id,idempotency_key) DO NOTHING;
  END IF;
  GET DIAGNOSTICS v_count=ROW_COUNT;

  INSERT INTO event_cpd_points_outbox(
    tenant_id,idempotency_key,booking_type,booking_id,trigger_type,evidence_type,evidence_id,evidence_snapshot
  )
  SELECT p_tenant_id,'replay:'||p_replay_id||':attendance:'||o.provider||':'||o.booking_type||':'||
      o.booking_id||':'||o.attendance_target_id,
    o.booking_type,o.booking_id,'attendance',o.provider,o.outcome_revision_id::text,
    jsonb_build_object('type',o.provider,'finalized',true,'status',o.status,
      'revisionId',o.outcome_revision_id,'attendanceTargetId',o.attendance_target_id,
      'replayId',p_replay_id)
  FROM attendance_current_outcome o
  JOIN attendance_target t ON t.id=o.attendance_target_id AND t.tenant_id=o.tenant_id
  WHERE o.tenant_id=p_tenant_id AND t.event_id=p_event_id AND o.status='attended'
    AND o.booking_type=CASE WHEN p_event_type='event' THEN 'booking' ELSE 'complex_event_booking' END
    AND (p_booking_ids IS NULL OR o.booking_id=ANY(p_booking_ids))
  ON CONFLICT(tenant_id,idempotency_key) DO NOTHING;
  GET DIAGNOSTICS v_added=ROW_COUNT;
  v_count:=v_count+v_added;
  UPDATE event_cpd_points_replay SET enqueued_count=v_count WHERE id=p_replay_id;
  RETURN v_count;
END $$;

ALTER TABLE public.event_cpd_points_rule ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.member_cpd_points_ledger ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.event_cpd_points_award_attempt ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.event_cpd_points_followup ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.event_cpd_points_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.event_cpd_points_replay ENABLE ROW LEVEL SECURITY;
CREATE POLICY service_role_all ON public.event_cpd_points_rule FOR ALL TO service_role USING(true) WITH CHECK(true);
CREATE POLICY service_role_all ON public.member_cpd_points_ledger FOR ALL TO service_role USING(true) WITH CHECK(true);
CREATE POLICY service_role_all ON public.event_cpd_points_award_attempt FOR ALL TO service_role USING(true) WITH CHECK(true);
CREATE POLICY service_role_all ON public.event_cpd_points_followup FOR ALL TO service_role USING(true) WITH CHECK(true);
CREATE POLICY service_role_all ON public.event_cpd_points_outbox FOR ALL TO service_role USING(true) WITH CHECK(true);
CREATE POLICY service_role_all ON public.event_cpd_points_replay FOR ALL TO service_role USING(true) WITH CHECK(true);
REVOKE ALL ON public.event_cpd_points_rule,public.member_cpd_points_ledger,
  public.event_cpd_points_award_attempt,public.event_cpd_points_followup,
  public.event_cpd_points_outbox,public.event_cpd_points_replay FROM anon,authenticated;
REVOKE ALL ON FUNCTION public.replace_event_cpd_points_rules(uuid,text,uuid,jsonb) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.record_event_cpd_points_award(jsonb) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.reverse_event_cpd_points_award(uuid,uuid,text,text,jsonb) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.append_event_cpd_points_reversal(uuid,uuid,text,text,text,jsonb) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.followup_event_cpd_points_booking() FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.followup_event_cpd_points_qr_reversal() FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.followup_event_cpd_points_online_downgrade() FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.enqueue_event_cpd_points_from_booking() FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.enqueue_event_cpd_points_from_checkin() FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.enqueue_event_cpd_points_from_attendance() FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.claim_event_cpd_points_outbox(integer) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.complete_event_cpd_points_outbox(uuid,uuid) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.fail_event_cpd_points_outbox(uuid,uuid,text,integer) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.enqueue_event_cpd_points_replay(uuid,text,uuid,text,uuid,uuid[],text,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.replace_event_cpd_points_rules(uuid,text,uuid,jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.record_event_cpd_points_award(jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.reverse_event_cpd_points_award(uuid,uuid,text,text,jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.claim_event_cpd_points_outbox(integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.complete_event_cpd_points_outbox(uuid,uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.fail_event_cpd_points_outbox(uuid,uuid,text,integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.enqueue_event_cpd_points_replay(uuid,text,uuid,text,uuid,uuid[],text,text) TO service_role;