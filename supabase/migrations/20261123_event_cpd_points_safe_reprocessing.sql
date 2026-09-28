-- Only confirmed runs are persisted. Preview RPCs are STABLE/read-only and
-- return bounded keyset pages, with a chained digest carried in a signed token.
-- The pinned installer owns the transaction, including post-apply verification.
CREATE TABLE IF NOT EXISTS public.event_cpd_points_reprocessing_run (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES public.tenant(id),
  requested_by text NOT NULL,
  reason text NOT NULL CHECK (length(trim(reason)) BETWEEN 1 AND 500),
  scope jsonb NOT NULL,
  preview_digest text NOT NULL,
  enqueued_count integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS public.event_cpd_points_reprocessing_item (
  replay_id uuid NOT NULL REFERENCES public.event_cpd_points_reprocessing_run(id),
  tenant_id uuid NOT NULL REFERENCES public.tenant(id),
  booking_type text NOT NULL,
  booking_id uuid NOT NULL,
  approved jsonb NOT NULL,
  idempotency_key text,
  PRIMARY KEY(replay_id,booking_type,booking_id),
  UNIQUE(tenant_id,idempotency_key)
);
DROP TRIGGER IF EXISTS protect_cpd_points_reprocessing_run ON public.event_cpd_points_reprocessing_run;
CREATE TRIGGER protect_cpd_points_reprocessing_run BEFORE UPDATE OR DELETE
 ON public.event_cpd_points_reprocessing_run FOR EACH ROW
 EXECUTE FUNCTION public.protect_member_cpd_points_ledger();
DROP TRIGGER IF EXISTS protect_cpd_points_reprocessing_item ON public.event_cpd_points_reprocessing_item;
CREATE TRIGGER protect_cpd_points_reprocessing_item BEFORE UPDATE OR DELETE
 ON public.event_cpd_points_reprocessing_item FOR EACH ROW
 EXECUTE FUNCTION public.protect_member_cpd_points_ledger();
ALTER TABLE public.event_cpd_points_reprocessing_run ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.event_cpd_points_reprocessing_item ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.event_cpd_points_reprocessing_run,public.event_cpd_points_reprocessing_item FROM PUBLIC,anon,authenticated;
GRANT SELECT ON public.event_cpd_points_reprocessing_run,public.event_cpd_points_reprocessing_item TO service_role;

CREATE OR REPLACE FUNCTION public.event_cpd_points_reprocessing_scope(
 p_tenant_id uuid,p_scope jsonb,p_after text DEFAULT NULL,p_limit integer DEFAULT NULL)
RETURNS TABLE(booking_type text,booking_id uuid,event_id uuid)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public AS $$
BEGIN
 IF auth.role() IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'service_role is required'; END IF;
 IF p_tenant_id IS NULL THEN RAISE EXCEPTION 'invalid scope'; END IF;
 IF p_scope->>'mode'='selected' THEN
   IF jsonb_typeof(p_scope->'registrations') IS DISTINCT FROM 'array'
     OR jsonb_array_length(p_scope->'registrations') NOT BETWEEN 1 AND 1000 THEN
     RAISE EXCEPTION 'invalid selected scope';
   END IF;
   IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_scope->'registrations') r
     WHERE coalesce(r->>'booking_source','') NOT IN ('standard','complex')
       OR r->>'booking_id' IS NULL OR r->>'event_id' IS NULL) THEN
     RAISE EXCEPTION 'invalid registration identity';
   END IF;
   RETURN QUERY SELECT q.bt,q.bid,q.eid FROM (
     SELECT DISTINCT CASE r->>'booking_source' WHEN 'standard' THEN 'booking' ELSE 'complex_event_booking' END AS bt,
       (r->>'booking_id')::uuid AS bid,(r->>'event_id')::uuid AS eid
       FROM jsonb_array_elements(p_scope->'registrations') r
   ) q WHERE p_after IS NULL OR q.bt||':'||q.bid::text>p_after
     ORDER BY q.bt||':'||q.bid::text LIMIT p_limit;
 ELSIF p_scope->>'mode'='all_event' THEN
   IF p_scope->>'event_type'='simple' THEN
     IF NOT EXISTS(SELECT 1 FROM event e WHERE e.id=(p_scope->>'event_id')::uuid AND e.tenant_id=p_tenant_id) THEN
       RAISE EXCEPTION 'event not found';
     END IF;
     RETURN QUERY SELECT 'booking'::text,b.id,b.event_id FROM booking b
       WHERE b.tenant_id=p_tenant_id AND b.event_id=(p_scope->>'event_id')::uuid
         AND (p_after IS NULL OR 'booking:'||b.id::text>p_after)
       ORDER BY 'booking:'||b.id::text LIMIT p_limit;
   ELSIF p_scope->>'event_type'='complex' THEN
     IF NOT EXISTS(SELECT 1 FROM complex_event e WHERE e.id=(p_scope->>'event_id')::uuid AND e.tenant_id=p_tenant_id) THEN
       RAISE EXCEPTION 'event not found';
     END IF;
     RETURN QUERY SELECT 'complex_event_booking'::text,b.id,b.event_id FROM complex_event_booking b
       WHERE b.tenant_id=p_tenant_id AND b.event_id=(p_scope->>'event_id')::uuid
         AND (p_after IS NULL OR 'complex_event_booking:'||b.id::text>p_after)
       ORDER BY 'complex_event_booking:'||b.id::text LIMIT p_limit;
   ELSE RAISE EXCEPTION 'invalid event type'; END IF;
 ELSE RAISE EXCEPTION 'invalid scope'; END IF;
END $$;

CREATE OR REPLACE FUNCTION public.evaluate_event_cpd_points_reprocessing_row(
 p_tenant_id uuid,p_booking_type text,p_booking_id uuid,p_event_id uuid
) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public AS $$
#variable_conflict use_variable
DECLARE
 b jsonb; r event_cpd_points_rule%ROWTYPE; member_ids uuid[]; member_id uuid;
 outcome text; evidence jsonb; evidence_id text; evidence_type text; online record; qr record;
 event_type text:=CASE p_booking_type WHEN 'booking' THEN 'event' ELSE 'complex_event' END;
BEGIN
 IF auth.role() IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'service_role is required'; END IF;
 IF p_booking_type='booking' THEN
   SELECT to_jsonb(x) INTO b FROM booking x WHERE x.id=p_booking_id AND x.tenant_id=p_tenant_id AND x.event_id=p_event_id;
 ELSIF p_booking_type='complex_event_booking' THEN
   SELECT to_jsonb(x) INTO b FROM complex_event_booking x WHERE x.id=p_booking_id AND x.tenant_id=p_tenant_id AND x.event_id=p_event_id;
 ELSE RAISE EXCEPTION 'invalid booking type'; END IF;
 IF b IS NULL THEN RAISE EXCEPTION 'registration not found in requested tenant/event'; END IF;
 SELECT * INTO r FROM event_cpd_points_rule x WHERE x.tenant_id=p_tenant_id
   AND x.event_id=p_event_id AND x.event_type=event_type AND x.active
   AND (x.ticket_id=b->>'ticket_class_id' OR x.ticket_id IS NULL)
   ORDER BY (x.ticket_id IS NOT NULL) DESC LIMIT 1;
 -- Match resolveMember: its initial escaped ILIKE searches the untrimmed
 -- stored email. A padded stored email is accepted only via the independently
 -- checked booking.member_id hint, never by a broader automatic soft join.
 SELECT array_agg(m.id ORDER BY m.id) INTO member_ids FROM member m
   WHERE m.tenant_id=p_tenant_id AND nullif(trim(b->>'attendee_email'),'') IS NOT NULL
   AND lower(m.email)=lower(trim(b->>'attendee_email'));
 IF cardinality(member_ids)=1 THEN member_id:=member_ids[1]; END IF;
 IF coalesce(cardinality(member_ids),0)=0 AND b->>'member_id' IS NOT NULL
   AND nullif(trim(b->>'attendee_email'),'') IS NOT NULL THEN
   SELECT m.id INTO member_id FROM member m WHERE m.tenant_id=p_tenant_id
     AND m.id=(b->>'member_id')::uuid AND lower(trim(m.email))=lower(trim(b->>'attendee_email'));
 END IF;
 -- Any native positive award blocks recovery, even after reversal, adjustment
 -- or a subsequent change between registration and attendance triggers.
 IF EXISTS(SELECT 1 FROM member_cpd_points_ledger l WHERE l.tenant_id=p_tenant_id
     AND l.booking_type=p_booking_type AND l.booking_id=p_booking_id
     AND l.event_type=event_type AND l.event_id=p_event_id AND l.entry_kind='event_award') THEN
   outcome:='already_awarded';
 ELSIF b->>'status' IS DISTINCT FROM 'confirmed' THEN outcome:='ineligible';
 ELSIF r.id IS NULL THEN outcome:='no_rule';
 ELSIF r.is_no_award OR r.points_value=0 THEN outcome:='no_award';
 ELSIF member_id IS NULL THEN outcome:='unmatched_member';
 ELSIF r.trigger_type='registration' THEN
   outcome:='eligible'; evidence_type:='confirmed_booking'; evidence_id:=p_booking_id::text; evidence:='{}';
 ELSE
   IF p_booking_type='booking' AND b->>'checked_in_at' IS NOT NULL
     AND (b->>'check_in_reversed_at' IS NULL OR (b->>'checked_in_at')::timestamptz>(b->>'check_in_reversed_at')::timestamptz) THEN
     evidence_type:='qr_checkin'; evidence_id:=p_booking_id::text;
     evidence:=jsonb_build_object('type','qr_checkin','checkedInAt',b->'checked_in_at','checkInReversedAt',b->'check_in_reversed_at');
   ELSIF p_booking_type='complex_event_booking' THEN
     SELECT c.* INTO qr FROM complex_event_session_checkin c JOIN complex_event_session s
       ON s.id=c.session_id AND s.tenant_id=c.tenant_id AND s.complex_event_id=c.complex_event_id
       WHERE c.tenant_id=p_tenant_id AND c.booking_id=p_booking_id AND c.complex_event_id=p_event_id
       AND c.checked_in_at IS NOT NULL AND (c.check_in_reversed_at IS NULL OR c.checked_in_at>c.check_in_reversed_at)
       ORDER BY c.id LIMIT 1;
     IF FOUND THEN
       evidence_type:='qr_checkin'; evidence_id:=qr.id::text;
       evidence:=jsonb_build_object('type','qr_checkin','checkedInAt',qr.checked_in_at,
         'checkInReversedAt',qr.check_in_reversed_at,'sessionId',qr.session_id);
     END IF;
   END IF;
   IF evidence IS NULL THEN
     SELECT o.* INTO online FROM attendance_current_outcome o JOIN attendance_target t
       ON t.id=o.attendance_target_id AND t.tenant_id=o.tenant_id AND t.event_id=p_event_id
       WHERE o.tenant_id=p_tenant_id AND o.booking_type=p_booking_type AND o.booking_id=p_booking_id
       AND o.provider IN ('zoom','teams') AND o.status='attended' AND o.outcome_revision_id IS NOT NULL
       AND t.tracking_enabled IS DISTINCT FROM false ORDER BY o.attendance_target_id,o.provider LIMIT 1;
     IF FOUND THEN
       evidence_type:=online.provider; evidence_id:=online.outcome_revision_id::text;
       evidence:=jsonb_build_object('type',online.provider,'attendanceTargetId',online.attendance_target_id,
         'revisionId',online.outcome_revision_id,'status','attended','finalized',true);
     END IF;
   END IF;
   outcome:=CASE WHEN evidence IS NULL THEN 'missing_attendance' ELSE 'eligible' END;
 END IF;
 RETURN jsonb_build_object(
   'booking_id',p_booking_id,'booking_source',CASE p_booking_type WHEN 'booking' THEN 'standard' ELSE 'complex' END,
   'booking_type',p_booking_type,'event_id',p_event_id,'event_type',event_type,
   'attendee_name',trim(coalesce(b->>'attendee_first_name','')||' '||coalesce(b->>'attendee_last_name','')),
   'ticket_id',b->'ticket_class_id','member_id',member_id,'outcome',outcome,
   'rule',CASE WHEN r.id IS NULL THEN NULL ELSE jsonb_build_object(
     'id',r.id,'points',r.points_value::text,'trigger',r.trigger_type,'ticket_id',r.ticket_id,'no_award',r.is_no_award) END,
   'trigger',r.trigger_type,'proposed_points',CASE WHEN outcome='eligible' THEN r.points_value ELSE 0 END::text,
   'evidence_type',evidence_type,'evidence_id',evidence_id,'evidence',evidence);
END $$;

CREATE OR REPLACE FUNCTION public.preview_event_cpd_points_reprocessing(
 p_tenant_id uuid,p_scope jsonb,p_after text DEFAULT NULL,p_digest text DEFAULT '',
 p_count integer DEFAULT 0,p_eligible integer DEFAULT 0,p_points numeric DEFAULT 0
) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public AS $$
DECLARE s record; item jsonb; rows jsonb:='[]'; after_key text; more boolean:=false; n integer:=0;
 failed boolean:=false;
BEGIN
 IF auth.role() IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'service_role is required'; END IF;
 FOR s IN SELECT * FROM event_cpd_points_reprocessing_scope(p_tenant_id,p_scope,p_after,101) x
   ORDER BY x.booking_type||':'||x.booking_id::text LIMIT 101 LOOP
   IF n=100 THEN more:=true; EXIT; END IF;
   BEGIN
     item:=evaluate_event_cpd_points_reprocessing_row(p_tenant_id,s.booking_type,s.booking_id,s.event_id);
   EXCEPTION WHEN OTHERS THEN
     -- Ownership/scope violations remain hard denials. Operational evaluation
     -- failures are visible against the affected registration, never converted
     -- to "missing attendance" or an apparently successful zero-point preview.
     IF SQLERRM='registration not found in requested tenant/event' THEN RAISE; END IF;
     item:=jsonb_build_object('booking_id',s.booking_id,
       'booking_source',CASE s.booking_type WHEN 'booking' THEN 'standard' ELSE 'complex' END,
       'event_id',s.event_id,'rule',NULL,'trigger',NULL,'proposed_points','0',
       'outcome','evaluation_error','detail','Eligibility could not be evaluated. Resolve the unavailable data and start a new preview.');
     failed:=true;
   END;
   p_digest:=encode(sha256(convert_to(p_digest||item::text,'UTF8')),'hex'); p_count:=p_count+1;
   IF item->>'outcome'='eligible' THEN
     p_eligible:=p_eligible+1; p_points:=p_points+(item->>'proposed_points')::numeric;
   END IF;
   rows:=rows||jsonb_build_array(item); n:=n+1; after_key:=s.booking_type||':'||s.booking_id::text;
   IF failed THEN EXIT; END IF;
 END LOOP;
 RETURN jsonb_build_object('rows',rows,'digest',p_digest,'after',after_key,
   'complete',NOT more AND NOT failed,'evaluation_failed',failed,
   'totals',jsonb_build_object('registrations',p_count,'eligible',p_eligible,'proposed_points',p_points::text));
END $$;

CREATE OR REPLACE FUNCTION public.confirm_event_cpd_points_reprocessing(
 p_tenant_id uuid,p_actor text,p_scope jsonb,p_digest text,p_reason text,p_request_id uuid
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE existing event_cpd_points_reprocessing_run%ROWTYPE; s record; item jsonb;
 digest text:=''; items jsonb:='[]'; eligible integer:=0; key text;
BEGIN
 IF auth.role() IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'service_role is required'; END IF;
 IF p_request_id IS NULL OR p_tenant_id IS NULL OR nullif(trim(p_actor),'') IS NULL
   OR coalesce(length(trim(p_reason)),0) NOT BETWEEN 1 AND 500 THEN RAISE EXCEPTION 'reason and request identity required'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('cpd-reprocess:'||p_request_id,0));
 SELECT * INTO existing FROM event_cpd_points_reprocessing_run WHERE id=p_request_id;
 IF FOUND THEN
   IF existing.tenant_id<>p_tenant_id OR existing.requested_by<>p_actor
     OR existing.scope<>p_scope OR existing.preview_digest<>p_digest OR existing.reason<>trim(p_reason) THEN
     RAISE EXCEPTION 'request identity conflict';
   END IF;
   RETURN jsonb_build_object('replay_id',existing.id,'enqueued_count',existing.enqueued_count);
 END IF;
 -- Current rows are re-evaluated, not trusted from the client. Changes during a
 -- long preview (including rows inserted behind its cursor) invalidate review.
 FOR s IN SELECT * FROM event_cpd_points_reprocessing_scope(p_tenant_id,p_scope) x
   ORDER BY x.booking_type||':'||x.booking_id::text LOOP
   item:=evaluate_event_cpd_points_reprocessing_row(p_tenant_id,s.booking_type,s.booking_id,s.event_id);
   digest:=encode(sha256(convert_to(digest||item::text,'UTF8')),'hex'); items:=items||jsonb_build_array(item);
   IF item->>'outcome'='eligible' THEN eligible:=eligible+1; END IF;
 END LOOP;
 IF digest IS DISTINCT FROM p_digest THEN RAISE EXCEPTION 'preview stale: review the changed scope and eligibility again'; END IF;
 IF eligible=0 THEN RAISE EXCEPTION 'no eligible registrations'; END IF;
 INSERT INTO event_cpd_points_reprocessing_run(id,tenant_id,requested_by,reason,scope,preview_digest,enqueued_count)
 VALUES(p_request_id,p_tenant_id,p_actor,trim(p_reason),p_scope,p_digest,eligible);
 FOR item IN SELECT value FROM jsonb_array_elements(items) LOOP
   key:=CASE WHEN item->>'outcome'='eligible' THEN 'reviewed:'||p_request_id||':'||(item->>'booking_type')||':'||(item->>'booking_id') END;
   INSERT INTO event_cpd_points_reprocessing_item(replay_id,tenant_id,booking_type,booking_id,approved,idempotency_key)
   VALUES(p_request_id,p_tenant_id,item->>'booking_type',(item->>'booking_id')::uuid,item,key);
   IF key IS NOT NULL THEN
     INSERT INTO event_cpd_points_outbox(tenant_id,idempotency_key,booking_type,booking_id,trigger_type,evidence_type,evidence_id,evidence_snapshot)
     VALUES(p_tenant_id,key,item->>'booking_type',(item->>'booking_id')::uuid,item->>'trigger',
       item->>'evidence_type',item->>'evidence_id',coalesce(item->'evidence','{}'));
   END IF;
 END LOOP;
 RETURN jsonb_build_object('replay_id',p_request_id,'enqueued_count',eligible);
END $$;

-- Wrap, do not fork, the existing transactional ledger writer. The underlying
-- function is no longer directly callable by service clients.
DO $$
BEGIN
 IF to_regprocedure('public.record_event_cpd_points_award_unreviewed(jsonb)') IS NULL THEN
   ALTER FUNCTION public.record_event_cpd_points_award(jsonb) RENAME TO record_event_cpd_points_award_unreviewed;
 END IF;
END $$;
REVOKE ALL ON FUNCTION public.record_event_cpd_points_award_unreviewed(jsonb) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.enqueue_event_cpd_points_replay(uuid,text,uuid,text,uuid,uuid[],text,text)
 FROM PUBLIC,anon,authenticated,service_role;
CREATE OR REPLACE FUNCTION public.record_event_cpd_points_award(p_attempt jsonb)
RETURNS public.event_cpd_points_award_attempt
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
#variable_conflict use_variable
DECLARE approved jsonb; current_row jsonb; event_id uuid; event_type text;
 tenant_id uuid:=(p_attempt->>'tenant_id')::uuid; booking_id uuid:=(p_attempt->>'booking_id')::uuid;
 booking_type text:=p_attempt->>'booking_type'; result event_cpd_points_award_attempt;
BEGIN
 IF auth.role() IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'service_role is required'; END IF;
 -- Preserve the original engine's booking -> event lock order.
 IF booking_type='booking' THEN
   SELECT b.event_id INTO event_id FROM booking b WHERE b.tenant_id=tenant_id AND b.id=booking_id FOR UPDATE;
   event_type:='event';
 ELSIF booking_type='complex_event_booking' THEN
   SELECT b.event_id INTO event_id FROM complex_event_booking b WHERE b.tenant_id=tenant_id AND b.id=booking_id FOR UPDATE;
   event_type:='complex_event';
 ELSE RAISE EXCEPTION 'invalid booking type'; END IF;
 IF event_id IS NOT NULL THEN
   PERFORM pg_advisory_xact_lock(hashtextextended(tenant_id::text||':cpd-points:'||event_type||':'||event_id::text,0));
 END IF;
 SELECT i.approved INTO approved FROM event_cpd_points_reprocessing_item i
   WHERE i.tenant_id=tenant_id AND i.idempotency_key=p_attempt->>'idempotency_key';
 IF approved IS NOT NULL THEN
   IF approved->>'booking_id' IS DISTINCT FROM booking_id::text
     OR approved->>'booking_type' IS DISTINCT FROM booking_type THEN RAISE EXCEPTION 'approved identity mismatch'; END IF;
   IF event_id IS DISTINCT FROM (approved->>'event_id')::uuid THEN
     p_attempt:=p_attempt||jsonb_build_object('status','skipped_not_qualifying','detail','needs_review: booking changed');
   ELSE
     -- Hold the selected contract dependencies until the existing writer has
     -- finished. Otherwise a tracking toggle or session deletion between the
     -- read-only evaluator and the evidence writer could escape review.
     PERFORM 1 FROM event_cpd_points_rule r WHERE r.tenant_id=tenant_id
       AND r.event_id=event_id AND r.event_type=event_type AND r.active FOR SHARE;
     PERFORM 1 FROM member m WHERE m.tenant_id=tenant_id
       AND m.id=(approved->>'member_id')::uuid FOR SHARE;
     IF approved->>'evidence_type' IN ('teams','zoom') THEN
       PERFORM 1 FROM attendance_current_outcome o WHERE o.tenant_id=tenant_id
         AND o.booking_type=booking_type AND o.booking_id=booking_id
         AND o.attendance_target_id::text=approved->'evidence'->>'attendanceTargetId' FOR UPDATE;
       PERFORM 1 FROM attendance_target t WHERE t.tenant_id=tenant_id
         AND t.id::text=approved->'evidence'->>'attendanceTargetId' FOR SHARE;
     ELSIF approved->>'evidence_type'='qr_checkin' AND booking_type='complex_event_booking' THEN
       PERFORM 1 FROM complex_event_session_checkin c WHERE c.tenant_id=tenant_id
         AND c.id::text=approved->>'evidence_id' FOR UPDATE;
       PERFORM 1 FROM complex_event_session s WHERE s.tenant_id=tenant_id
         AND s.id::text=approved->'evidence'->>'sessionId' FOR SHARE;
     END IF;
     current_row:=evaluate_event_cpd_points_reprocessing_row(tenant_id,booking_type,booking_id,event_id);
     IF current_row->>'outcome'='already_awarded' THEN
       p_attempt:=p_attempt||jsonb_build_object('status','already_awarded','detail','Existing award preserved');
     ELSIF current_row IS DISTINCT FROM approved THEN
       p_attempt:=p_attempt||jsonb_build_object('status','skipped_not_qualifying','detail','needs_review: approved eligibility, member, rule or evidence changed');
     ELSE
       -- The persisted contract, never caller-supplied hints, supplies award
       -- authority. The underlying engine then locks/rechecks its evidence.
       p_attempt:=p_attempt||jsonb_build_object('member_id',approved->'member_id',
         'event_type',approved->'event_type','trigger_type',approved->'trigger',
         'evidence_type',approved->'evidence_type','evidence_id',approved->'evidence_id',
         'evidence_snapshot',approved->'evidence','status','awarded');
     END IF;
   END IF;
 ELSIF left(p_attempt->>'idempotency_key',9)='reviewed:' THEN
   RAISE EXCEPTION 'approved replay contract missing';
 END IF;
 -- Recovery and concurrent automatic processing share the same occurrence
 -- boundary even when configuration changes trigger type after an award.
 IF EXISTS(SELECT 1 FROM member_cpd_points_ledger l WHERE l.tenant_id=tenant_id
   AND l.booking_type=booking_type AND l.booking_id=booking_id AND l.event_id=event_id
   AND l.event_type=event_type AND l.entry_kind='event_award') THEN
   p_attempt:=p_attempt||jsonb_build_object('status','already_awarded');
 END IF;
 SELECT * INTO result FROM record_event_cpd_points_award_unreviewed(p_attempt);
 RETURN result;
END $$;

CREATE OR REPLACE FUNCTION public.event_cpd_points_reprocessing_results(
 p_tenant_id uuid,p_replay_id uuid,p_page integer DEFAULT 1,p_page_size integer DEFAULT 50
) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public AS $$
DECLARE run event_cpd_points_reprocessing_run; result jsonb;
BEGIN
 IF auth.role() IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'service_role is required'; END IF;
 SELECT * INTO run FROM event_cpd_points_reprocessing_run r WHERE r.id=p_replay_id AND r.tenant_id=p_tenant_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'replay not found'; END IF;
 p_page:=greatest(1,p_page); p_page_size:=least(100,greatest(1,p_page_size));
 WITH outcomes AS (
   SELECT i.*,a.status AS attempt_status,a.detail AS attempt_detail,
     CASE WHEN a.status='awarded' THEN coalesce(a.points_value,0) ELSE 0 END AS awarded_points,
     CASE WHEN i.idempotency_key IS NULL THEN 'unchanged'
       WHEN a.status='awarded' THEN 'awarded'
       WHEN a.status NOT IN ('pending_evidence','error') THEN 'unchanged'
       WHEN o.status='dead' THEN 'failed'
       WHEN o.status='retry' OR (o.status='processing' AND o.attempts>1) THEN 'retrying'
       WHEN o.status='complete' THEN 'failed'
       WHEN o.id IS NULL THEN 'failed'
       ELSE 'pending' END AS actual_status,
     o.last_error
   FROM event_cpd_points_reprocessing_item i
   LEFT JOIN event_cpd_points_outbox o ON o.tenant_id=i.tenant_id AND o.idempotency_key=i.idempotency_key
   LEFT JOIN LATERAL (SELECT x.status,x.detail,x.points_value FROM event_cpd_points_award_attempt x
     WHERE x.tenant_id=i.tenant_id AND x.idempotency_key=i.idempotency_key
     ORDER BY x.delivery_attempt DESC LIMIT 1) a ON true
   WHERE i.replay_id=p_replay_id AND i.tenant_id=p_tenant_id
 ), page_rows AS (
   SELECT * FROM outcomes ORDER BY booking_type,booking_id LIMIT p_page_size OFFSET (p_page-1)*p_page_size
 )
 SELECT jsonb_build_object('replay_id',run.id,'reason',run.reason,'created_at',run.created_at,
   'page',p_page,'page_size',p_page_size,'total',count(*),
   'complete',count(*) FILTER(WHERE actual_status IN ('pending','retrying'))=0,
   'totals',jsonb_build_object('registrations',count(*),'pending',count(*) FILTER(WHERE actual_status='pending'),
     'awarded',count(*) FILTER(WHERE actual_status='awarded'),'unchanged',count(*) FILTER(WHERE actual_status='unchanged'),
     'retrying',count(*) FILTER(WHERE actual_status='retrying'),'failed',count(*) FILTER(WHERE actual_status='failed'),
     'awarded_points',coalesce(sum(awarded_points),0)::text),
   'rows',(SELECT coalesce(jsonb_agg(jsonb_build_object(
     'booking_id',booking_id,'booking_source',approved->>'booking_source','event_id',approved->>'event_id',
     'attendee_name',approved->>'attendee_name','status',actual_status,
     'detail',coalesce(attempt_detail,last_error,attempt_status,approved->>'outcome'),
     'points',awarded_points::text) ORDER BY booking_type,booking_id),'[]') FROM page_rows))
 INTO result FROM outcomes;
 RETURN result;
END $$;

REVOKE ALL ON FUNCTION public.event_cpd_points_reprocessing_scope(uuid,jsonb,text,integer),
 public.evaluate_event_cpd_points_reprocessing_row(uuid,text,uuid,uuid),
 public.preview_event_cpd_points_reprocessing(uuid,jsonb,text,text,integer,integer,numeric),
 public.confirm_event_cpd_points_reprocessing(uuid,text,jsonb,text,text,uuid),
 public.record_event_cpd_points_award(jsonb),
 public.event_cpd_points_reprocessing_results(uuid,uuid,integer,integer)
 FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.event_cpd_points_reprocessing_scope(uuid,jsonb,text,integer),
 public.evaluate_event_cpd_points_reprocessing_row(uuid,text,uuid,uuid),
 public.preview_event_cpd_points_reprocessing(uuid,jsonb,text,text,integer,integer,numeric),
 public.confirm_event_cpd_points_reprocessing(uuid,text,jsonb,text,text,uuid),
 public.record_event_cpd_points_award(jsonb),
 public.event_cpd_points_reprocessing_results(uuid,uuid,integer,integer)
 TO service_role;