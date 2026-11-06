-- Explicit item values opt training/complex events into attendance-only awards.
-- NULL preserves legacy event/ticket rules; zero is an explicit no-award item.
ALTER TABLE public.event_agenda_item ADD COLUMN IF NOT EXISTS cpd_points numeric;
ALTER TABLE public.complex_event_session ADD COLUMN IF NOT EXISTS cpd_points numeric;
ALTER TABLE public.event_agenda_item ADD CONSTRAINT agenda_cpd_points_valid
  CHECK (cpd_points IS NULL OR (cpd_points BETWEEN 0 AND 10000 AND cpd_points=round(cpd_points,6)
    AND (cpd_points=0 OR end_date IS NULL OR end_date=start_date)));
ALTER TABLE public.complex_event_session ADD CONSTRAINT session_cpd_points_valid
  CHECK (cpd_points IS NULL OR (cpd_points BETWEEN 0 AND 10000 AND cpd_points=round(cpd_points,6)));

-- A snapshot on each immutable ledger row is the daily certificate authority.
-- No new FK: deleting an agenda/session must not delete its earned history.
CREATE OR REPLACE FUNCTION public.item_cpd_mode(p_tenant uuid,p_event_type text,p_event uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public AS $$
 SELECT CASE WHEN p_event_type='event' THEN
   EXISTS(SELECT 1 FROM event e JOIN event_agenda_item a ON a.event_id=e.id AND a.tenant_id=e.tenant_id
     WHERE e.id=p_event AND e.tenant_id=p_tenant AND e.is_training AND a.cpd_points IS NOT NULL)
 WHEN p_event_type='complex_event' THEN
   EXISTS(SELECT 1 FROM complex_event_session s WHERE s.tenant_id=p_tenant AND s.complex_event_id=p_event AND s.cpd_points IS NOT NULL)
 ELSE false END
$$;

CREATE OR REPLACE FUNCTION public.item_cpd_candidates(p_tenant uuid,p_booking_type text,p_booking uuid,p_event uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public AS $$
DECLARE item record; evidence jsonb; day date; tz text; result jsonb:='[]'; ev_type text;
BEGIN
 IF auth.role() IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'service_role is required'; END IF;
 ev_type:=CASE p_booking_type WHEN 'booking' THEN 'event' WHEN 'complex_event_booking' THEN 'complex_event' END;
 IF ev_type IS NULL THEN RAISE EXCEPTION 'invalid booking type'; END IF;
 IF ev_type='event' THEN
   SELECT coalesce(nullif(to_jsonb(e)->>'timezone',''),'Europe/London') INTO tz FROM event e WHERE e.id=p_event AND e.tenant_id=p_tenant;
 ELSE
   SELECT coalesce(nullif(to_jsonb(e)->>'timezone',''),'Europe/London') INTO tz FROM complex_event e WHERE e.id=p_event AND e.tenant_id=p_tenant;
 END IF;
 FOR item IN
   SELECT a.id,a.cpd_points,a.start_date AS award_day,a.description AS title,'agenda_item'::text AS kind
   FROM event_agenda_item a WHERE ev_type='event' AND a.tenant_id=p_tenant AND a.event_id=p_event AND a.cpd_points>0
   UNION ALL
   SELECT s.id,s.cpd_points,(s.start_time AT TIME ZONE tz)::date,
     coalesce(to_jsonb(s)->>'title',to_jsonb(s)->>'name','Session'),'complex_event_session'
   FROM complex_event_session s WHERE ev_type='complex_event' AND s.tenant_id=p_tenant AND s.complex_event_id=p_event AND s.cpd_points>0
   ORDER BY award_day,id
 LOOP
   evidence:=NULL;
   -- A whole-event check-in cannot establish attendance at every agenda item.
   IF item.kind='complex_event_session' THEN
     SELECT jsonb_build_object('type','qr_checkin','checkedInAt',c.checked_in_at,'sessionId',c.session_id,'evidenceId',c.id)
     INTO evidence FROM complex_event_session_checkin c
     WHERE c.tenant_id=p_tenant AND c.complex_event_id=p_event AND c.booking_id=p_booking
       AND c.session_id=item.id AND c.checked_in_at IS NOT NULL
       AND (c.check_in_reversed_at IS NULL OR c.checked_in_at>c.check_in_reversed_at)
     ORDER BY c.id LIMIT 1;
   END IF;
   IF evidence IS NULL THEN
     SELECT jsonb_build_object('type',o.provider,'attendanceTargetId',t.id,
       'revisionId',o.outcome_revision_id,'evidenceId',o.outcome_revision_id,'status',o.status,'finalized',true)
     INTO evidence FROM attendance_current_outcome o JOIN attendance_target t
       ON t.id=o.attendance_target_id AND t.tenant_id=o.tenant_id
     WHERE o.tenant_id=p_tenant AND o.booking_type=p_booking_type AND o.booking_id=p_booking
       AND t.event_id=p_event AND t.target_type=item.kind AND t.target_id=item.id
       AND t.tracking_enabled AND o.status='attended' AND o.outcome_revision_id IS NOT NULL
     ORDER BY t.id,o.provider LIMIT 1;
   END IF;
   IF evidence IS NOT NULL AND item.award_day IS NOT NULL THEN
     result:=result||jsonb_build_array(jsonb_build_object('source_type',item.kind,'source_id',item.id,
       'day',item.award_day,'title',item.title,'points',item.cpd_points,'evidence',evidence));
   END IF;
 END LOOP;
 RETURN result;
END $$;

REVOKE ALL ON FUNCTION public.item_cpd_mode(uuid,text,uuid) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.item_cpd_candidates(uuid,text,uuid,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.item_cpd_mode(uuid,text,uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.item_cpd_candidates(uuid,text,uuid,uuid) TO service_role;

ALTER FUNCTION public.evaluate_event_cpd_points_reprocessing_row(uuid,text,uuid,uuid)
  RENAME TO evaluate_event_cpd_points_reprocessing_before_items;
CREATE FUNCTION public.evaluate_event_cpd_points_reprocessing_row(p_tenant_id uuid,p_booking_type text,p_booking_id uuid,p_event_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public AS $$
DECLARE result jsonb; candidates jsonb; missing jsonb:='[]'; item jsonb; total numeric:=0; ev text; b jsonb; member_ids uuid[];
BEGIN
 IF auth.role() IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'service_role is required'; END IF;
 ev:=CASE p_booking_type WHEN 'booking' THEN 'event' ELSE 'complex_event' END;
 result:=evaluate_event_cpd_points_reprocessing_before_items(p_tenant_id,p_booking_type,p_booking_id,p_event_id);
 IF NOT item_cpd_mode(p_tenant_id,ev,p_event_id) THEN RETURN result; END IF;
 -- Never supplement or split a pre-existing event-wide award.
 IF EXISTS(SELECT 1 FROM member_cpd_points_ledger l WHERE l.tenant_id=p_tenant_id AND l.booking_type=p_booking_type
   AND l.booking_id=p_booking_id AND l.entry_kind='event_award' AND NOT (l.rule_snapshot ? 'itemCpd')) THEN
   RETURN result||jsonb_build_object('outcome','already_awarded','proposed_points','0');
 END IF;
 IF p_booking_type='booking' THEN
   SELECT to_jsonb(x) INTO b FROM booking x WHERE x.tenant_id=p_tenant_id AND x.id=p_booking_id AND x.event_id=p_event_id;
 ELSE
   SELECT to_jsonb(x) INTO b FROM complex_event_booking x WHERE x.tenant_id=p_tenant_id AND x.id=p_booking_id AND x.event_id=p_event_id;
 END IF;
 IF b IS NULL OR b->>'status'<>'confirmed' OR outstanding_registration_is_held_for(p_booking_id,'points') THEN
   RETURN result||jsonb_build_object('outcome','ineligible','proposed_points','0'); END IF;
 SELECT array_agg(m.id) INTO member_ids FROM member m WHERE m.tenant_id=p_tenant_id
   AND lower(trim(m.email))=lower(trim(b->>'attendee_email'));
 IF cardinality(member_ids) IS DISTINCT FROM 1 THEN
   RETURN result||jsonb_build_object('outcome','unmatched_member','proposed_points','0'); END IF;
 candidates:=item_cpd_candidates(p_tenant_id,p_booking_type,p_booking_id,p_event_id);
 FOR item IN SELECT value FROM jsonb_array_elements(candidates) LOOP
   IF NOT EXISTS(SELECT 1 FROM member_cpd_points_ledger l WHERE l.tenant_id=p_tenant_id AND l.booking_type=p_booking_type
     AND l.booking_id=p_booking_id AND l.entry_kind='event_award'
     AND l.rule_snapshot->'itemCpd'->>'source_id'=item->>'source_id'
     AND l.rule_snapshot->'itemCpd'->>'source_type'=item->>'source_type') THEN
     missing:=missing||jsonb_build_array(item); total:=total+(item->>'points')::numeric;
   END IF;
 END LOOP;
 RETURN result||jsonb_build_object('member_id',member_ids[1],'trigger','attendance',
   'outcome',CASE WHEN total>0 THEN 'eligible' WHEN jsonb_array_length(candidates)>0 THEN 'already_awarded' ELSE 'missing_attendance' END,
   'proposed_points',total::text,'rule',jsonb_build_object('id',NULL,'scope','attended_items','points',total::text,'trigger','attendance','ticket_id',NULL,'no_award',false),
   'evidence_type',NULL,'evidence_id',NULL,'evidence',jsonb_build_object('itemCpd',missing));
END $$;

ALTER FUNCTION public.record_event_cpd_points_award(jsonb) RENAME TO record_event_cpd_points_award_before_items;
CREATE FUNCTION public.record_event_cpd_points_award(p_attempt jsonb)
RETURNS event_cpd_points_award_attempt LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
#variable_conflict use_variable
DECLARE tenant uuid:=(p_attempt->>'tenant_id')::uuid; booking_id uuid:=(p_attempt->>'booking_id')::uuid;
 booking_type text:=p_attempt->>'booking_type'; event_id uuid; ev text; current_row jsonb; approved jsonb;
 item jsonb; ledger_id uuid; total numeric:=0; result event_cpd_points_award_attempt; attempt_number integer;
BEGIN
 IF auth.role() IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'service_role is required'; END IF;
 IF tenant IS NULL OR nullif(p_attempt->>'idempotency_key','') IS NULL THEN RAISE EXCEPTION 'Invalid CPD attempt'; END IF;
 IF booking_type='booking' THEN
   SELECT b.event_id INTO event_id FROM booking b WHERE b.id=booking_id AND b.tenant_id=tenant FOR UPDATE; ev:='event';
 ELSIF booking_type='complex_event_booking' THEN
   SELECT b.event_id INTO event_id FROM complex_event_booking b WHERE b.id=booking_id AND b.tenant_id=tenant FOR UPDATE; ev:='complex_event';
 ELSE RAISE EXCEPTION 'invalid booking type'; END IF;
 IF event_id IS NOT NULL THEN
   PERFORM pg_advisory_xact_lock(hashtextextended(tenant::text||':cpd-points:'||ev||':'||event_id::text,0));
 END IF;
 IF event_id IS NULL OR NOT item_cpd_mode(tenant,ev,event_id) THEN
   RETURN record_event_cpd_points_award_before_items(p_attempt);
 END IF;
 IF outstanding_registration_is_held_for(booking_id,'points') THEN RAISE EXCEPTION 'Registration-only import award hold'; END IF;
 -- Configuration, attendance and member identity remain locked through publication.
 PERFORM 1 FROM event_agenda_item a WHERE a.tenant_id=tenant AND a.event_id=event_id FOR SHARE;
 PERFORM 1 FROM complex_event_session s WHERE s.tenant_id=tenant AND s.complex_event_id=event_id FOR SHARE;
 PERFORM 1 FROM attendance_current_outcome o WHERE o.tenant_id=tenant AND o.booking_id=booking_id FOR SHARE;
 PERFORM 1 FROM attendance_target t WHERE t.tenant_id=tenant AND t.event_id=event_id FOR SHARE;
 PERFORM 1 FROM complex_event_session_checkin c WHERE c.tenant_id=tenant AND c.booking_id=booking_id FOR SHARE;
 current_row:=evaluate_event_cpd_points_reprocessing_row(tenant,booking_type,booking_id,event_id);
 SELECT i.approved INTO approved FROM event_cpd_points_reprocessing_item i WHERE i.tenant_id=tenant
   AND i.idempotency_key=p_attempt->>'idempotency_key';
 IF approved IS NOT NULL AND current_row IS DISTINCT FROM approved AND current_row->>'outcome'<>'already_awarded' THEN
   RAISE EXCEPTION 'Approved daily CPD evidence changed; preview again';
 ELSIF approved IS NULL AND left(p_attempt->>'idempotency_key',9)='reviewed:' THEN
   RAISE EXCEPTION 'approved replay contract missing';
 END IF;
 IF current_row->>'outcome'='eligible' AND p_attempt->>'trigger_type'='attendance' THEN
   PERFORM 1 FROM member m WHERE m.id=(current_row->>'member_id')::uuid AND m.tenant_id=tenant FOR SHARE;
   IF NOT FOUND OR current_row IS DISTINCT FROM evaluate_event_cpd_points_reprocessing_row(tenant,booking_type,booking_id,event_id)
     THEN RAISE EXCEPTION 'CPD attendee identity or evidence changed; retry'; END IF;
   FOR item IN SELECT value FROM jsonb_array_elements(current_row->'evidence'->'itemCpd') LOOP
     INSERT INTO member_cpd_points_ledger(tenant_id,member_id,entry_kind,points_value,event_type,event_id,booking_type,booking_id,
       ticket_id,ticket_name_snapshot,award_trigger,evidence_type,evidence_id,evidence_snapshot,rule_snapshot,occurrence_key)
     VALUES(tenant,(current_row->>'member_id')::uuid,'event_award',(item->>'points')::numeric,ev,event_id,booking_type,booking_id,
       current_row->>'ticket_id',p_attempt->>'ticket_name_snapshot','attendance',item->'evidence'->>'type',
       item->'evidence'->>'evidenceId',item->'evidence',jsonb_build_object('itemCpd',item),
       ev||':'||event_id||':'||booking_type||':'||booking_id||':item:'||(item->>'source_type')||':'||(item->>'source_id'))
     RETURNING id INTO ledger_id;
     total:=total+(item->>'points')::numeric;
   END LOOP;
 END IF;
 SELECT coalesce(max(a.delivery_attempt),0)+1 INTO attempt_number FROM event_cpd_points_award_attempt a
   WHERE a.tenant_id=tenant AND a.idempotency_key=p_attempt->>'idempotency_key';
 INSERT INTO event_cpd_points_award_attempt(tenant_id,idempotency_key,event_type,event_id,booking_type,booking_id,member_id,
   trigger_type,points_value,ledger_entry_id,status,detail,delivery_attempt)
 VALUES(tenant,p_attempt->>'idempotency_key',ev,event_id,booking_type,booking_id,(current_row->>'member_id')::uuid,
   p_attempt->>'trigger_type',total,ledger_id,
   CASE WHEN total>0 THEN 'awarded' WHEN current_row->>'outcome'='already_awarded' THEN 'already_awarded'
     ELSE 'skipped_not_qualifying' END,'Item attendance CPD: '||(current_row->>'outcome'),attempt_number)
 RETURNING * INTO result;
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION public.record_event_cpd_points_award(jsonb) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.record_event_cpd_points_award_before_items(jsonb) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.evaluate_event_cpd_points_reprocessing_row(uuid,text,uuid,uuid) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.evaluate_event_cpd_points_reprocessing_before_items(uuid,text,uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.record_event_cpd_points_award(jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.evaluate_event_cpd_points_reprocessing_row(uuid,text,uuid,uuid) TO service_role;

CREATE FUNCTION public.item_cpd_certificate_state(p_tenant uuid,p_booking_type text,p_booking uuid,p_event uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public AS $$
DECLARE ev text:=CASE p_booking_type WHEN 'booking' THEN 'event' ELSE 'complex_event' END;
 latest_end timestamptz; tz text; ready boolean;
BEGIN
 IF auth.role() IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'service_role is required'; END IF;
 IF NOT item_cpd_mode(p_tenant,ev,p_event) THEN RETURN '{"enabled":false}'::jsonb; END IF;
 IF ev='event' THEN
   SELECT coalesce(nullif(to_jsonb(e)->>'timezone',''),'Europe/London') INTO tz FROM event e WHERE e.id=p_event AND e.tenant_id=p_tenant;
   SELECT max((coalesce(a.end_date,a.start_date)+coalesce(a.end_time,'23:59:59'::time)) AT TIME ZONE tz)
   INTO latest_end FROM event_agenda_item a WHERE a.tenant_id=p_tenant AND a.event_id=p_event AND a.cpd_points>0;
 ELSE
   SELECT max(s.end_time) INTO latest_end FROM complex_event_session s
     WHERE s.tenant_id=p_tenant AND s.complex_event_id=p_event AND s.cpd_points>0;
 END IF;
 ready:=latest_end IS NOT NULL AND latest_end<=now()
 AND NOT EXISTS(SELECT 1 FROM complex_event_session s WHERE ev='complex_event' AND s.tenant_id=p_tenant
   AND s.complex_event_id=p_event AND s.cpd_points>0 AND (s.start_time IS NULL OR s.end_time IS NULL))
 AND NOT EXISTS(
   SELECT 1 FROM attendance_target t WHERE t.tenant_id=p_tenant AND t.event_id=p_event AND t.tracking_enabled
   AND ((t.target_type='agenda_item' AND EXISTS(SELECT 1 FROM event_agenda_item a WHERE a.id=t.target_id AND a.tenant_id=p_tenant AND a.cpd_points>0))
    OR (t.target_type='complex_event_session' AND EXISTS(SELECT 1 FROM complex_event_session s WHERE s.id=t.target_id AND s.tenant_id=p_tenant AND s.cpd_points>0)))
   AND NOT EXISTS(SELECT 1 FROM attendance_current_outcome o WHERE o.tenant_id=p_tenant AND o.attendance_target_id=t.id
     AND o.provider=t.provider AND o.booking_type=p_booking_type AND o.booking_id=p_booking
     AND o.status IN ('attended','below_threshold','absent')));
 RETURN jsonb_build_object('enabled',true,'ready',ready,'ends_at',latest_end);
END $$;
REVOKE ALL ON FUNCTION public.item_cpd_certificate_state(uuid,text,uuid,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.item_cpd_certificate_state(uuid,text,uuid,uuid) TO service_role;

CREATE FUNCTION public.serialize_item_cpd_configuration() RETURNS trigger
LANGUAGE plpgsql SET search_path=public AS $$
DECLARE rowdata jsonb; previous jsonb; ev text; parent_id uuid;
BEGIN
 rowdata:=CASE WHEN TG_OP='DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END;
 previous:=CASE WHEN TG_OP='INSERT' THEN NULL ELSE to_jsonb(OLD) END;
 ev:=CASE WHEN TG_TABLE_NAME='complex_event_session' THEN 'complex_event' ELSE 'event' END;
 parent_id:=(rowdata->>CASE WHEN TG_TABLE_NAME='complex_event_session' THEN 'complex_event_id' ELSE 'event_id' END)::uuid;
 IF TG_OP='UPDATE' AND (previous->>'cpd_points' IS NOT NULL OR rowdata->>'cpd_points' IS NOT NULL)
   AND (previous->>'tenant_id' IS DISTINCT FROM rowdata->>'tenant_id'
    OR previous->>'event_id' IS DISTINCT FROM rowdata->>'event_id'
    OR previous->>'complex_event_id' IS DISTINCT FROM rowdata->>'complex_event_id') THEN
   RAISE EXCEPTION 'CPD items cannot be moved to a different event or tenant';
 END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended((rowdata->>'tenant_id')||':cpd-points:'||ev||':'||parent_id::text,0));
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER serialize_agenda_cpd BEFORE INSERT OR UPDATE OR DELETE ON public.event_agenda_item
FOR EACH ROW EXECUTE FUNCTION public.serialize_item_cpd_configuration();
CREATE TRIGGER serialize_session_cpd BEFORE INSERT OR UPDATE OR DELETE ON public.complex_event_session
FOR EACH ROW EXECUTE FUNCTION public.serialize_item_cpd_configuration();
REVOKE ALL ON FUNCTION public.serialize_item_cpd_configuration() FROM PUBLIC,anon,authenticated;
