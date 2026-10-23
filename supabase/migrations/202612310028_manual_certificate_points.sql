BEGIN;
-- Service-only award attached to a real pending attendee delivery. The booking
-- lock is shared with automatic award processing; unique occurrence is retained.
CREATE OR REPLACE FUNCTION public.award_manual_certificate_points(
 p_delivery_id uuid,p_rule_id uuid,p_points numeric,p_reason text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE d attendee_cpd_certificate_delivery; b jsonb; r event_cpd_points_rule;
 m uuid; n integer; awarded uuid; bt text; et text; eid uuid;
BEGIN
 IF auth.role() IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'service_role required'; END IF;
 IF length(trim(p_reason))<15 OR length(p_reason)>2000 THEN RAISE EXCEPTION 'Specific override reason required'; END IF;
 SELECT * INTO d FROM attendee_cpd_certificate_delivery WHERE id=p_delivery_id FOR UPDATE;
 IF NOT FOUND OR d.status<>'pending' OR d.purpose<>'attendee' OR coalesce(d.actor,'')='' THEN
   RAISE EXCEPTION 'Pending attendee delivery required';
 END IF;
 IF d.booking_source='standard' THEN
   SELECT to_jsonb(x) INTO b FROM booking x WHERE x.id=d.booking_id AND x.tenant_id=d.tenant_id FOR UPDATE;
   bt:='booking'; et:='event';
 ELSE
   SELECT to_jsonb(x) INTO b FROM complex_event_booking x WHERE x.id=d.booking_id AND x.tenant_id=d.tenant_id FOR UPDATE;
   bt:='complex_event_booking'; et:='complex_event';
 END IF;
 IF b IS NULL OR b->>'status'<>'confirmed' THEN RAISE EXCEPTION 'Confirmed booking required'; END IF;
 eid:=(b->>'event_id')::uuid;
 SELECT count(*),(array_agg(id))[1] INTO n,m FROM member
 WHERE tenant_id=d.tenant_id AND lower(trim(email))=lower(trim(b->>'attendee_email'));
 IF n<>1 OR m::text IS DISTINCT FROM d.provenance->>'attendee_member_id'
 OR lower(trim(d.recipient)) IS DISTINCT FROM lower(trim(b->>'attendee_email')) THEN
   RAISE EXCEPTION 'Attendee identity changed';
 END IF;
 SELECT id INTO awarded FROM member_cpd_points_ledger WHERE tenant_id=d.tenant_id
 AND booking_type=bt AND booking_id=d.booking_id AND event_type=et AND event_id=eid AND entry_kind='event_award';
 IF FOUND THEN RETURN awarded; END IF;
 SELECT * INTO r FROM event_cpd_points_rule WHERE tenant_id=d.tenant_id AND event_id=eid
 AND event_type=et AND active AND (ticket_id=b->>'ticket_class_id' OR ticket_id IS NULL)
 ORDER BY (ticket_id IS NOT NULL) DESC LIMIT 1 FOR SHARE;
 IF r.id IS DISTINCT FROM p_rule_id OR r.is_no_award OR r.points_value IS DISTINCT FROM p_points
 OR r.points_value<=0 THEN RAISE EXCEPTION 'Award rule changed'; END IF;
 INSERT INTO member_cpd_points_ledger(tenant_id,member_id,entry_kind,points_value,event_type,event_id,
 booking_type,booking_id,ticket_id,ticket_name_snapshot,award_trigger,evidence_type,evidence_id,
 evidence_snapshot,rule_id,rule_snapshot,occurrence_key,reason,created_by)
 VALUES(d.tenant_id,m,'event_award',r.points_value,et,eid,bt,d.booking_id,r.ticket_id,b->>'ticket_class_name',
 r.trigger_type,'manual_certificate_override',d.id::text,
 jsonb_build_object('delivery_id',d.id,'reason',trim(p_reason),'actor',d.actor,'attendance_overridden',true),
 r.id,to_jsonb(r),et||':'||eid::text||':'||bt||':'||d.booking_id::text||':'||r.trigger_type,trim(p_reason),d.actor)
 RETURNING id INTO awarded;
 RETURN awarded;
END $$;
REVOKE ALL ON FUNCTION public.award_manual_certificate_points(uuid,uuid,numeric,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.award_manual_certificate_points(uuid,uuid,numeric,text) TO service_role;
COMMIT;
