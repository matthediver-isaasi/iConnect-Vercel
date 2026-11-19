BEGIN;
ALTER FUNCTION public.reconcile_removed_speaker_award_grant(uuid,uuid,boolean,text,uuid,text)
  RENAME TO reconcile_removed_legacy_speaker_award_grant;
CREATE OR REPLACE FUNCTION public.reconcile_removed_speaker_award_grant(
  p_tenant_id uuid,p_grant_id uuid,p_revoke boolean,p_actor_type text,p_actor_id uuid,p_actor_label text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE g public.speaker_award_grant; mb public.member_badge; did_revoke boolean:=false;
BEGIN
  -- Lock parents before grants, consistently with processing and agenda saves.
  SELECT * INTO g FROM public.speaker_award_grant WHERE tenant_id=p_tenant_id AND id=p_grant_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Speaker award grant not found'; END IF;
  IF g.agenda_item_id IS NULL THEN
    RETURN public.reconcile_removed_legacy_speaker_award_grant(p_tenant_id,p_grant_id,p_revoke,p_actor_type,p_actor_id,p_actor_label);
  END IF;
  IF g.event_type='event' THEN PERFORM 1 FROM public.event WHERE id=g.event_id AND tenant_id=p_tenant_id FOR UPDATE;
  ELSE PERFORM 1 FROM public.complex_event WHERE id=g.event_id AND tenant_id=p_tenant_id FOR UPDATE; END IF;
  SELECT * INTO g FROM public.speaker_award_grant WHERE tenant_id=p_tenant_id AND id=p_grant_id FOR UPDATE;
  IF g.removal_reconciled_at IS NOT NULL THEN
    RETURN jsonb_build_object('status','already_processed','revoked',false,'revoke_requested',g.removal_revoke_requested);
  END IF;
  UPDATE public.speaker_award_grant SET status='cancelled',removal_reconciled_at=now(),removal_revoke_requested=p_revoke
    WHERE id=g.id;
  IF p_revoke AND g.member_badge_id IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(hashtextextended(p_tenant_id::text||g.member_id::text||g.badge_id::text,5674));
    SELECT * INTO mb FROM public.member_badge WHERE id=g.member_badge_id AND tenant_id=p_tenant_id FOR UPDATE;
    -- Manual/other credential sources are never owned by this reconciler.
    IF mb.source='speaker_award' AND mb.revoked_at IS NULL
      AND EXISTS(SELECT 1 FROM public.speaker_award_grant creator WHERE creator.tenant_id=p_tenant_id
        AND creator.member_badge_id=mb.id AND mb.source_ref=creator.event_type||':'||creator.event_id::text)
      AND NOT EXISTS(SELECT 1 FROM public.speaker_award_grant other WHERE other.tenant_id=p_tenant_id
        AND other.id<>g.id AND other.member_id=g.member_id AND other.badge_id=g.badge_id
        AND other.member_badge_id=mb.id AND (other.status IN ('granted','pending')
          OR (other.removal_reconciled_at IS NOT NULL AND other.removal_revoke_requested=false))) THEN
      UPDATE public.member_badge SET revoked_at=now(),revoked_by_type=COALESCE(p_actor_type,'system'),
        revoked_by_id=p_actor_id,revoked_by_label=COALESCE(p_actor_label,'Speaker assignment reconciliation') WHERE id=mb.id;
      did_revoke:=true;
    END IF;
  END IF;
  RETURN jsonb_build_object('status','processed','revoked',did_revoke,'revoke_requested',p_revoke);
END $$;

CREATE FUNCTION public.reconcile_training_speaker_scope(p_tenant uuid,p_event uuid,p_revoke boolean DEFAULT false,p_actor uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE g record; result jsonb; removed integer:=0; revoked integer:=0;
BEGIN
  PERFORM 1 FROM public.event WHERE tenant_id=p_tenant AND id=p_event AND is_training FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Training event not found'; END IF;
  FOR g IN SELECT grant_row.* FROM public.speaker_award_grant grant_row
    WHERE grant_row.tenant_id=p_tenant AND grant_row.event_type='event' AND grant_row.event_id=p_event
      AND grant_row.agenda_item_id IS NOT NULL AND grant_row.removal_reconciled_at IS NULL
      AND NOT EXISTS(SELECT 1 FROM public.event_agenda_item a WHERE a.id=grant_row.agenda_item_id
        AND a.event_id=p_event AND a.tenant_id=p_tenant AND COALESCE(to_jsonb(a.speaker_ids),'[]') ? grant_row.speaker_id::text)
    ORDER BY grant_row.id LOOP
    result:=public.reconcile_removed_speaker_award_grant(p_tenant,g.id,p_revoke,'admin',p_actor,'Tenant administrator');
    removed:=removed+1;
    IF result->>'revoked'='true' THEN revoked:=revoked+1; END IF;
  END LOOP;
  UPDATE public.event SET speaker_scope_ready=true WHERE tenant_id=p_tenant AND id=p_event;
  PERFORM public.sync_training_speaker_recognition(p_tenant,p_event);
  RETURN jsonb_build_object('removed',removed,'revoked',revoked);
END $$;

-- Source writes can revoke detached recognition, but never issue artifacts.
-- Existing unscoped training recognition remains historical, not reallocated.
CREATE OR REPLACE FUNCTION public.revoke_detached_speaker_recognition()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE doc jsonb; typ text; eid uuid; tid uuid; training boolean;
BEGIN
  doc:=CASE WHEN TG_OP='DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END;
  typ:=CASE WHEN TG_TABLE_NAME IN ('event','event_agenda_item') THEN 'event' ELSE 'complex_event' END;
  tid:=(doc->>'tenant_id')::uuid;
  eid:=CASE WHEN TG_TABLE_NAME IN ('event','complex_event') THEN (doc->>'id')::uuid
    WHEN typ='event' THEN (doc->>'event_id')::uuid ELSE (doc->>'complex_event_id')::uuid END;
  SELECT is_training INTO training FROM public.event WHERE id=eid AND tenant_id=tid;
  training:=COALESCE(training,TG_TABLE_NAME='event' AND doc->>'is_training'='true');
  PERFORM pg_advisory_xact_lock(hashtextextended(tid::text||typ||eid::text,4838));
  UPDATE public.speaker_recognition r SET status='revoked',revoked_at=COALESCE(revoked_at,now())
    WHERE r.tenant_id=tid AND r.event_type=typ AND r.event_id=eid
    AND (NOT COALESCE(training,false) OR r.agenda_item_id IS NOT NULL)
    AND ((COALESCE(training,false) AND NOT EXISTS(SELECT 1 FROM public.event_agenda_item a
        WHERE a.tenant_id=tid AND a.event_id=eid AND a.id=r.agenda_item_id
          AND COALESCE(to_jsonb(a.speaker_ids),'[]') ? r.speaker_id::text))
      OR (NOT COALESCE(training,false) AND NOT EXISTS (
        SELECT 1 FROM public.speaker_recognition_references(tid,typ,eid) refs WHERE refs.speaker_id=r.speaker_id))
      OR (TG_TABLE_NAME IN ('event','complex_event') AND
        (TG_OP='DELETE' OR doc->>'status'<>'published' OR doc->>'event_state'='draft')));
  RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION public.refresh_speaker_recognition_badges()
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE refreshed integer;
BEGIN
  WITH candidates AS (
    SELECT r.id,g.id grant_id,g.badge_id,g.member_badge_id FROM public.speaker_recognition r
    JOIN public.speaker_award_grant g ON g.tenant_id=r.tenant_id AND g.event_type=r.event_type AND g.event_id=r.event_id
      AND g.agenda_item_id IS NOT DISTINCT FROM r.agenda_item_id AND g.speaker_id=r.speaker_id AND g.member_id=r.member_id
    JOIN public.badge b ON b.tenant_id=g.tenant_id AND b.id=g.badge_id
    WHERE g.member_badge_id IS NOT NULL
      AND (r.member_badge_id IS DISTINCT FROM g.member_badge_id OR r.badge_id IS DISTINCT FROM g.badge_id)
    ORDER BY r.id LIMIT 100
  )
  UPDATE public.speaker_recognition r SET grant_id=c.grant_id,badge_id=c.badge_id,member_badge_id=c.member_badge_id
    FROM candidates c WHERE r.id=c.id;
  GET DIAGNOSTICS refreshed=ROW_COUNT;
  RETURN refreshed;
END $$;

CREATE OR REPLACE VIEW public.speaker_award_history AS
SELECT r.id,r.tenant_id,r.speaker_id,r.member_id,r.event_type,r.event_id,
  r.snapshot->>'event_title' event_title,r.created_at awarded_at,r.status,
  COALESCE(r.snapshot->'badge'->>'name',b.name) badge_name,
  COALESCE(r.snapshot->'badge'->>'image_url',b.image_url) badge_image_url,
  CASE WHEN r.badge_id IS NULL THEN NULL WHEN r.member_id IS NULL THEN r.status
    WHEN mb.id IS NULL THEN 'unavailable' WHEN mb.revoked_at IS NOT NULL THEN 'revoked' ELSE 'active' END badge_status,
  CASE WHEN r.badge_id IS NULL THEN NULL WHEN r.member_id IS NULL THEN 'speaker_recognition'
    WHEN mb.source='speaker_award' THEN 'member_badge' ELSE 'existing_member_badge' END badge_evidence,
  r.certificate_status,
  (r.status='active' AND r.certificate_status='issued' AND r.pdf_path IS NOT NULL AND r.pdf_sha256 IS NOT NULL) certificate_available,
  r.agenda_item_id,r.snapshot->>'agenda_description' agenda_description,
  r.snapshot->>'agenda_start_date' agenda_start_date,r.snapshot->>'agenda_end_date' agenda_end_date,
  r.snapshot->>'event_timezone' agenda_timezone
FROM public.speaker_recognition r
LEFT JOIN public.badge b ON b.id=r.badge_id AND b.tenant_id=r.tenant_id
LEFT JOIN public.member_badge mb ON mb.id=r.member_badge_id AND mb.tenant_id=r.tenant_id AND mb.member_id=r.member_id AND mb.badge_id=r.badge_id
UNION ALL
SELECT g.id,g.tenant_id,g.speaker_id,g.member_id,g.event_type,g.event_id,
  COALESCE(g.agenda_snapshot->>'event_title',e.title,ce.title,'Event no longer available'),g.created_at,g.status,
  b.name,b.image_url,CASE WHEN mb.id IS NULL THEN 'unavailable' WHEN mb.revoked_at IS NOT NULL THEN 'revoked' ELSE 'active' END,
  CASE WHEN mb.source='speaker_award' THEN 'member_badge' ELSE 'existing_member_badge' END,
  'unavailable'::text,false,g.agenda_item_id,g.agenda_snapshot->>'description',
  g.agenda_snapshot->>'start_date',g.agenda_snapshot->>'end_date',g.agenda_snapshot->>'timezone'
FROM public.speaker_award_grant g
LEFT JOIN public.member_badge mb ON mb.id=g.member_badge_id AND mb.tenant_id=g.tenant_id AND mb.member_id=g.member_id AND mb.badge_id=g.badge_id
LEFT JOIN public.badge b ON b.id=g.badge_id AND b.tenant_id=g.tenant_id
LEFT JOIN public.event e ON g.event_type='event' AND e.id=g.event_id AND e.tenant_id=g.tenant_id
LEFT JOIN public.complex_event ce ON g.event_type='complex_event' AND ce.id=g.event_id AND ce.tenant_id=g.tenant_id
WHERE g.member_badge_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.speaker_recognition r
  WHERE r.tenant_id=g.tenant_id AND r.event_type=g.event_type AND r.event_id=g.event_id
    AND r.agenda_item_id IS NOT DISTINCT FROM g.agenda_item_id AND r.speaker_id=g.speaker_id
    AND r.member_id IS NOT DISTINCT FROM g.member_id AND r.badge_id=g.badge_id AND r.member_badge_id=g.member_badge_id);
REVOKE ALL ON public.speaker_award_history FROM PUBLIC,anon,authenticated;
GRANT SELECT ON public.speaker_award_history TO service_role;
REVOKE ALL ON FUNCTION public.reconcile_training_speaker_scope(uuid,uuid,boolean,uuid) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.reconcile_removed_speaker_award_grant(uuid,uuid,boolean,text,uuid,text),
  public.reconcile_removed_legacy_speaker_award_grant(uuid,uuid,boolean,text,uuid,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.reconcile_removed_speaker_award_grant(uuid,uuid,boolean,text,uuid,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.reconcile_training_speaker_scope(uuid,uuid,boolean,uuid) TO service_role;
NOTIFY pgrst,'reload schema';
COMMIT;
