BEGIN;
-- The old implementation remains the authority for ordinary/complex events.
-- Only its conflict target changes to the new legacy partial index.
DO $$
DECLARE definition text;
BEGIN
  SELECT pg_get_functiondef('public.sync_speaker_recognition(uuid,text,uuid)'::regprocedure) INTO definition;
  IF strpos(definition,'ON CONFLICT (tenant_id,event_type,event_id,speaker_id) DO UPDATE')=0 THEN
    RAISE EXCEPTION 'Unexpected recognition implementation; review migration compatibility';
  END IF;
  definition:=replace(definition,
    'ON CONFLICT (tenant_id,event_type,event_id,speaker_id) DO UPDATE',
    'ON CONFLICT (tenant_id,event_type,event_id,speaker_id) WHERE agenda_item_id IS NULL DO UPDATE');
  EXECUTE definition;
END $$;
ALTER FUNCTION public.sync_speaker_recognition(uuid,text,uuid) RENAME TO sync_legacy_speaker_recognition;
REVOKE ALL ON FUNCTION public.sync_legacy_speaker_recognition(uuid,text,uuid) FROM PUBLIC,anon,authenticated;

-- SQL uses the same minute-resolution wall-clock contract as agendaInstant:
-- date-only starts are local midnight and ambiguous/nonexistent minutes fail.
CREATE FUNCTION public.speaker_agenda_instant(p_date date,p_time time,p_zone text,p_end boolean DEFAULT false)
RETURNS timestamptz LANGUAGE plpgsql STABLE SET search_path=pg_catalog,public AS $$
DECLARE wall timestamp; candidate timestamptz; matches integer;
BEGIN
  IF EXTRACT(second FROM p_time)<>0 THEN
    RAISE EXCEPTION 'Agenda times must use whole minutes' USING ERRCODE='23514';
  END IF;
  wall:=p_date+COALESCE(p_time,CASE WHEN p_end THEN time '23:59' ELSE time '00:00' END);
  candidate:=wall AT TIME ZONE p_zone;
  SELECT count(*) INTO matches FROM generate_series(candidate-interval '26 hours',candidate+interval '26 hours',interval '1 minute') instant
    WHERE instant AT TIME ZONE p_zone=wall;
  IF matches<>1 THEN RAISE EXCEPTION 'Agenda time is ambiguous or does not exist in event timezone' USING ERRCODE='23514'; END IF;
  RETURN candidate;
END $$;

-- Scoped awards are entirely transactional. Save/removal, grants, badges and
-- vouchers take the same parent lock. No in-flight JS worker can fulfil an
-- obsolete assignment after a successful removal.
CREATE FUNCTION public.process_training_speaker_awards(p_tenant uuid,p_event uuid,p_assignment boolean DEFAULT false)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE e public.event; a public.event_agenda_item; s public.speaker; m public.member;
  g public.speaker_award_grant; cfg jsonb; o jsonb; bid uuid; value numeric; expiry text;
  mb uuid; vid uuid; started timestamptz; cutoff timestamptz; results jsonb:='[]'; code text;
BEGIN
  SELECT * INTO e FROM public.event WHERE tenant_id=p_tenant AND id=p_event AND is_training FOR UPDATE;
  IF NOT FOUND OR NOT e.speaker_scope_ready OR e.status<>'published' OR e.event_state='draft' THEN RETURN results; END IF;
  SELECT starts_at INTO cutoff FROM public.training_speaker_scope_policy WHERE singleton;
  FOR a IN SELECT * FROM public.event_agenda_item WHERE tenant_id=p_tenant AND event_id=p_event ORDER BY sort_order,id LOOP
    BEGIN
    cfg:=a.speaker_award_config;
    started:=public.speaker_agenda_instant(a.start_date,a.start_time,e.timezone);
    -- Allocation is never a retrospective send or historical award backfill.
    IF started<cutoff OR (NOT p_assignment AND started>now()) THEN CONTINUE; END IF;
    IF cfg->>'enabled' IS DISTINCT FROM 'true' THEN
      UPDATE public.speaker_award_grant SET status='skipped_no_award'
        WHERE tenant_id=p_tenant AND event_id=p_event AND agenda_item_id=a.id AND status='pending' AND voucher_id IS NULL;
      IF NOT p_assignment THEN UPDATE public.event_agenda_item SET speaker_awards_granted_at=now() WHERE id=a.id; END IF;
      CONTINUE;
    END IF;
    IF p_assignment AND cfg->>'badge_timing' IS DISTINCT FROM 'on_assignment' THEN CONTINUE; END IF;
    FOR s IN SELECT sp.* FROM public.speaker sp WHERE sp.tenant_id=p_tenant
      AND COALESCE(to_jsonb(a.speaker_ids),'[]') ? sp.id::text LOOP
      IF NOT p_assignment AND a.speaker_awards_granted_at IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM public.speaker_award_grant owed WHERE owed.tenant_id=p_tenant AND owed.event_id=p_event
          AND owed.agenda_item_id=a.id AND owed.speaker_id=s.id AND owed.status='pending'
      ) THEN CONTINUE; END IF;
      o:=COALESCE(cfg->'overrides'->s.id::text,'{}');
      IF o->>'excluded'='true' THEN
        UPDATE public.speaker_award_grant SET status='skipped_excluded'
          WHERE tenant_id=p_tenant AND event_id=p_event AND agenda_item_id=a.id AND speaker_id=s.id AND status='pending' AND voucher_id IS NULL;
        CONTINUE;
      END IF;
      bid:=NULLIF(COALESCE(o->>'badge_id',cfg->'default'->>'badge_id'),'')::uuid;
      IF NOT EXISTS(SELECT 1 FROM public.badge WHERE tenant_id=p_tenant AND id=bid) THEN bid:=NULL; END IF;
      value:=NULLIF(COALESCE(o->>'voucher_value',cfg->'default'->>'voucher_value'),'')::numeric;
      expiry:=NULLIF(COALESCE(o->>'voucher_expiry',cfg->'default'->>'voucher_expiry'),'');
      IF value<=0 OR expiry IS NULL THEN value:=NULL; END IF;
      IF p_assignment AND a.speaker_awards_granted_at IS NOT NULL THEN value:=NULL; END IF;
      SELECT * INTO m FROM public.member WHERE tenant_id=p_tenant
        AND (id=s.member_id OR (NULLIF(trim(s.email),'') IS NOT NULL AND lower(trim(email))=lower(trim(s.email))))
        ORDER BY (id=s.member_id) DESC NULLS LAST,id LIMIT 1;
      IF m.organization_id IS NULL THEN value:=NULL; END IF;
      IF m.id IS NULL THEN bid:=NULL; END IF;
      INSERT INTO public.speaker_award_grant(tenant_id,event_type,event_id,agenda_item_id,speaker_id,speaker_name,
        member_id,organization_id,status,badge_id,voucher_value,agenda_snapshot)
      VALUES(p_tenant,'event',p_event,a.id,s.id,s.full_name,m.id,m.organization_id,
        CASE WHEN m.id IS NULL THEN 'skipped_no_member' WHEN bid IS NULL AND value IS NULL THEN 'skipped_no_award' ELSE 'pending' END,
        bid,value,jsonb_build_object('agenda_item_id',a.id,'description',a.description,'start_date',a.start_date,
          'end_date',COALESCE(a.end_date,a.start_date),'start_time',a.start_time,'end_time',a.end_time,'timezone',e.timezone,'event_title',e.title))
      ON CONFLICT(tenant_id,event_id,agenda_item_id,speaker_id) WHERE agenda_item_id IS NOT NULL DO NOTHING;
      SELECT * INTO g FROM public.speaker_award_grant WHERE tenant_id=p_tenant AND event_id=p_event
        AND agenda_item_id=a.id AND speaker_id=s.id FOR UPDATE;
      -- Issuance and recipient provenance are never transferred on reassignment.
      IF g.member_id IS DISTINCT FROM m.id THEN CONTINUE; END IF;
      IF g.status='cancelled' THEN
        UPDATE public.speaker_award_grant SET status='pending',removal_reconciled_at=NULL,removal_revoke_requested=NULL,
          member_badge_id=CASE WHEN EXISTS(SELECT 1 FROM public.member_badge held WHERE held.id=g.member_badge_id
            AND held.tenant_id=p_tenant AND held.member_id=m.id AND held.badge_id=bid AND held.revoked_at IS NULL)
            THEN g.member_badge_id ELSE NULL END
          WHERE id=g.id RETURNING * INTO g;
      END IF;
      IF NOT p_assignment AND g.voucher_id IS NULL AND value IS NOT NULL THEN
        code:='SPK-'||replace(g.id::text,'-','');
        INSERT INTO public.voucher(tenant_id,organization_id,code,value,description,expires_at,issued_at,status,funding_source,created_by)
        VALUES(p_tenant,m.organization_id,code,value,'Speaker award — '||e.title||' — '||COALESCE(a.description,a.start_date::text),
          expiry::timestamptz,now(),'active','Speaker award','system:speaker-awards')
        RETURNING id INTO vid;
        UPDATE public.speaker_award_grant SET voucher_id=vid,voucher_value=value,organization_id=m.organization_id WHERE id=g.id;
      END IF;
      IF bid IS NOT NULL AND (NOT p_assignment OR cfg->>'badge_timing'='on_assignment') AND g.member_badge_id IS NULL THEN
        -- Serialise shared credentials across independent parents/lines too.
        PERFORM pg_advisory_xact_lock(hashtextextended(p_tenant::text||m.id::text||bid::text,5674));
        SELECT id INTO mb FROM public.member_badge WHERE tenant_id=p_tenant AND member_id=m.id AND badge_id=bid AND revoked_at IS NULL;
        IF mb IS NULL THEN
          INSERT INTO public.member_badge(tenant_id,badge_id,member_id,source,source_ref,created_by,awarded_by_type,awarded_by_label)
          VALUES(p_tenant,bid,m.id,'speaker_award','event:'||p_event::text,'system:speaker-awards','system','Speaker awards automation')
          RETURNING id INTO mb;
        ELSIF value IS NULL AND g.voucher_id IS NULL THEN
          -- Allocation creates a line entitlement, not another notification
          -- for an already-issued event-wide/manual/shared badge credential.
          UPDATE public.speaker_award_grant SET notified_at=COALESCE(notified_at,now()),
            detail=COALESCE(detail||'; ','')||'Existing badge retained; no duplicate badge notification'
            WHERE id=g.id;
        END IF;
        UPDATE public.speaker_award_grant SET member_badge_id=mb,badge_id=bid WHERE id=g.id;
      END IF;
      UPDATE public.speaker_award_grant SET status=CASE
        WHEN p_assignment AND (value IS NOT NULL OR (g.status='pending' AND g.voucher_value IS NOT NULL)) AND voucher_id IS NULL THEN 'pending'
        WHEN member_badge_id IS NOT NULL OR voucher_id IS NOT NULL THEN 'granted'
        WHEN m.id IS NULL THEN 'skipped_no_member' ELSE 'skipped_no_award' END WHERE id=g.id;
      results:=results||jsonb_build_array(jsonb_build_object('grant_id',g.id,'agenda_item_id',a.id,'speaker_id',s.id));
    END LOOP;
    IF NOT p_assignment THEN UPDATE public.event_agenda_item SET speaker_awards_granted_at=now() WHERE id=a.id; END IF;
    UPDATE public.event_agenda_item SET speaker_awards_error=NULL WHERE id=a.id;
    EXCEPTION WHEN OTHERS THEN
      UPDATE public.event_agenda_item SET speaker_awards_error=left(SQLERRM,500) WHERE id=a.id;
      results:=results||jsonb_build_array(jsonb_build_object('agenda_item_id',a.id,'error','Award processing failed; retry pending'));
    END;
  END LOOP;
  RETURN results;
END $$;

CREATE FUNCTION public.sync_training_speaker_recognition(p_tenant uuid,p_event uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE e public.event; a public.event_agenda_item; s public.speaker; g public.speaker_award_grant;
  cfg jsonb; o jsonb; bid uuid; tid uuid; recipient uuid; due boolean; cutoff timestamptz;
  started timestamptz; ended timestamptz; b jsonb; t jsonb; fields jsonb;
BEGIN
  SELECT * INTO e FROM public.event WHERE tenant_id=p_tenant AND id=p_event AND is_training FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;
  SELECT starts_at INTO cutoff FROM public.training_speaker_scope_policy WHERE singleton;
  -- Only scoped rows participate; legacy artifacts are not relabelled/revoked.
  UPDATE public.speaker_recognition r SET status='revoked',revoked_at=COALESCE(revoked_at,now())
    WHERE r.tenant_id=p_tenant AND r.event_type='event' AND r.event_id=p_event AND r.agenda_item_id IS NOT NULL
    AND (e.status<>'published' OR e.event_state='draft' OR NOT EXISTS (
      SELECT 1 FROM public.event_agenda_item line_ref WHERE line_ref.tenant_id=p_tenant AND line_ref.event_id=p_event AND line_ref.id=r.agenda_item_id
        AND COALESCE(to_jsonb(line_ref.speaker_ids),'[]') ? r.speaker_id::text
        AND EXISTS(SELECT 1 FROM public.speaker WHERE id=r.speaker_id AND tenant_id=p_tenant)
    ));
  IF NOT e.speaker_scope_ready OR e.status<>'published' OR e.event_state='draft' THEN RETURN; END IF;
  FOR a IN SELECT * FROM public.event_agenda_item WHERE tenant_id=p_tenant AND event_id=p_event ORDER BY sort_order,id LOOP
    cfg:=a.speaker_award_config;
    UPDATE public.speaker_recognition r SET certificate_status='unavailable',error='Certificate disabled before issuance'
      WHERE r.tenant_id=p_tenant AND r.event_id=p_event AND r.agenda_item_id=a.id AND r.pdf_path IS NULL
      AND (cfg->>'enabled' IS DISTINCT FROM 'true' OR cfg->'overrides'->r.speaker_id::text->>'excluded'='true'
        OR CASE WHEN COALESCE(cfg->'overrides'->r.speaker_id::text,'{}') ? 'certificate_template_id'
          THEN NULLIF(cfg->'overrides'->r.speaker_id::text->>'certificate_template_id','')
          ELSE NULLIF(cfg->'default'->>'certificate_template_id','') END IS NULL);
    started:=public.speaker_agenda_instant(a.start_date,a.start_time,e.timezone);
    ended:=public.speaker_agenda_instant(COALESCE(a.end_date,a.start_date),a.end_time,e.timezone,true);
    IF started<cutoff THEN
      UPDATE public.speaker_recognition SET certificate_status='unavailable',error='Agenda item predates scoped recognition'
        WHERE tenant_id=p_tenant AND event_id=p_event AND agenda_item_id=a.id AND pdf_path IS NULL;
      CONTINUE;
    END IF;
    IF cfg->>'enabled' IS DISTINCT FROM 'true' THEN CONTINUE; END IF;
    due:=started<=now();
    FOR s IN SELECT sp.* FROM public.speaker sp WHERE sp.tenant_id=p_tenant AND COALESCE(to_jsonb(a.speaker_ids),'[]') ? sp.id::text LOOP
      o:=COALESCE(cfg->'overrides'->s.id::text,'{}');
      IF o->>'excluded'='true' THEN CONTINUE; END IF;
      tid:=CASE WHEN o ? 'certificate_template_id' THEN NULLIF(o->>'certificate_template_id','')::uuid
        ELSE NULLIF(cfg->'default'->>'certificate_template_id','')::uuid END;
      bid:=NULLIF(COALESCE(o->>'badge_id',cfg->'default'->>'badge_id'),'')::uuid;
      IF NOT due THEN tid:=NULL;
      ELSIF a.speaker_recognition_processed_at IS NOT NULL THEN
        SELECT r.certificate_template_id INTO tid FROM public.speaker_recognition r WHERE r.tenant_id=p_tenant
          AND r.event_id=p_event AND r.agenda_item_id=a.id AND r.speaker_id=s.id;
      END IF;
      IF NOT due AND cfg->>'badge_timing' IS DISTINCT FROM 'on_assignment' THEN bid:=NULL; END IF;
      SELECT * INTO g FROM public.speaker_award_grant WHERE tenant_id=p_tenant AND event_id=p_event AND agenda_item_id=a.id AND speaker_id=s.id;
      SELECT matched.id INTO recipient FROM public.member matched WHERE matched.tenant_id=p_tenant
        AND (matched.id=s.member_id OR (NULLIF(trim(s.email),'') IS NOT NULL AND lower(trim(matched.email))=lower(trim(s.email))))
        ORDER BY (matched.id=s.member_id) DESC NULLS LAST,matched.id LIMIT 1;
      recipient:=COALESCE(g.member_id,recipient);
      IF recipient IS NOT NULL THEN bid:=CASE WHEN g.member_badge_id IS NOT NULL THEN g.badge_id ELSE NULL END; END IF;
      IF recipient IS NULL AND due AND a.speaker_recognition_processed_at IS NOT NULL
        AND cfg->>'badge_timing' IS DISTINCT FROM 'on_assignment' THEN
        SELECT r.badge_id INTO bid FROM public.speaker_recognition r WHERE r.tenant_id=p_tenant
          AND r.event_id=p_event AND r.agenda_item_id=a.id AND r.speaker_id=s.id;
      END IF;
      SELECT to_jsonb(badge) INTO b FROM public.badge WHERE id=bid AND tenant_id=p_tenant;
      IF b IS NULL THEN bid:=NULL; END IF;
      IF bid IS NULL AND tid IS NULL THEN CONTINUE; END IF;
      SELECT to_jsonb(ct) INTO t FROM public.cpd_certificate_template ct WHERE id=tid AND tenant_id=p_tenant;
      SELECT COALESCE(jsonb_agg(to_jsonb(p) ORDER BY page_number,display_order,p.id),'[]') INTO fields
        FROM public.cpd_certificate_placeholder p WHERE tenant_id=p_tenant AND template_id=tid;
      INSERT INTO public.speaker_recognition(tenant_id,event_type,event_id,agenda_item_id,speaker_id,member_id,grant_id,
        badge_id,member_badge_id,certificate_template_id,certificate_status,snapshot)
      VALUES(p_tenant,'event',p_event,a.id,s.id,recipient,g.id,bid,g.member_badge_id,tid,
        CASE WHEN tid IS NULL THEN 'unavailable' ELSE 'pending' END,
        jsonb_build_object('speaker_name',s.full_name,'speaker_email',s.email,'organization',s.organization,'member_id',recipient,
          'event_title',e.title,'event_start_date',e.start_date,'event_end_date',e.end_date,'event_timezone',e.timezone,
          'agenda_item_id',a.id,'agenda_description',a.description,'agenda_start_date',started,'agenda_end_date',ended,
          'badge',b,'badge_evidence',CASE WHEN recipient IS NULL THEN 'speaker_recognition' ELSE 'member_badge' END,
          'template',t,'placeholders',fields))
      ON CONFLICT(tenant_id,event_id,agenda_item_id,speaker_id) WHERE agenda_item_id IS NOT NULL DO UPDATE SET
        status=CASE WHEN speaker_recognition.member_id IS NOT DISTINCT FROM EXCLUDED.member_id THEN 'active' ELSE speaker_recognition.status END,
        revoked_at=CASE WHEN speaker_recognition.member_id IS NOT DISTINCT FROM EXCLUDED.member_id THEN NULL ELSE speaker_recognition.revoked_at END,
        badge_id=CASE WHEN EXCLUDED.member_badge_id IS NOT NULL AND speaker_recognition.member_id=EXCLUDED.member_id THEN EXCLUDED.badge_id ELSE speaker_recognition.badge_id END,
        member_badge_id=CASE WHEN EXCLUDED.member_badge_id IS NOT NULL AND speaker_recognition.member_id=EXCLUDED.member_id THEN EXCLUDED.member_badge_id ELSE speaker_recognition.member_badge_id END,
        grant_id=CASE WHEN EXCLUDED.member_badge_id IS NOT NULL AND speaker_recognition.member_id=EXCLUDED.member_id THEN EXCLUDED.grant_id ELSE speaker_recognition.grant_id END,
        certificate_template_id=CASE WHEN speaker_recognition.certificate_template_id IS NULL AND speaker_recognition.member_id IS NOT DISTINCT FROM EXCLUDED.member_id THEN EXCLUDED.certificate_template_id ELSE speaker_recognition.certificate_template_id END,
        certificate_status=CASE WHEN speaker_recognition.certificate_template_id IS NULL AND EXCLUDED.certificate_template_id IS NOT NULL
          AND speaker_recognition.member_id IS NOT DISTINCT FROM EXCLUDED.member_id THEN 'pending' ELSE speaker_recognition.certificate_status END,
        snapshot=CASE WHEN speaker_recognition.certificate_template_id IS NULL AND EXCLUDED.certificate_template_id IS NOT NULL
          AND speaker_recognition.member_id IS NOT DISTINCT FROM EXCLUDED.member_id THEN EXCLUDED.snapshot ELSE speaker_recognition.snapshot END;
    END LOOP;
    IF due THEN UPDATE public.event_agenda_item SET speaker_recognition_processed_at=now() WHERE id=a.id; END IF;
  END LOOP;
END $$;

-- A rescheduled pending certificate must not issue using the original due
-- decision. The immutable snapshot/PDF is retained; live eligibility is checked
-- again under the parent lock immediately before publication.
CREATE OR REPLACE FUNCTION public.finish_speaker_certificate(p_tenant uuid,p_id uuid,p_path text,p_sha256 text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE r public.speaker_recognition; a public.event_agenda_item; e public.event;
BEGIN
  SELECT * INTO r FROM public.speaker_recognition WHERE tenant_id=p_tenant AND id=p_id;
  IF NOT FOUND THEN RETURN false; END IF;
  PERFORM public.sync_speaker_recognition(p_tenant,r.event_type,r.event_id);
  IF r.agenda_item_id IS NOT NULL THEN
    SELECT * INTO e FROM public.event WHERE tenant_id=p_tenant AND id=r.event_id FOR UPDATE;
    SELECT * INTO a FROM public.event_agenda_item WHERE tenant_id=p_tenant AND event_id=r.event_id AND id=r.agenda_item_id;
    IF a.id IS NULL OR NOT e.speaker_scope_ready OR public.speaker_agenda_instant(a.start_date,a.start_time,e.timezone)>now()
      THEN RETURN false; END IF;
    IF public.speaker_agenda_instant(a.start_date,a.start_time,e.timezone)<
      (SELECT starts_at FROM public.training_speaker_scope_policy WHERE singleton) THEN RETURN false; END IF;
  END IF;
  IF p_path<>p_tenant::text||'/'||p_id::text||'.pdf' OR p_sha256 !~ '^[a-f0-9]{64}$' THEN
    RAISE EXCEPTION 'Invalid artifact reference';
  END IF;
  UPDATE public.speaker_recognition SET pdf_path=p_path,pdf_sha256=p_sha256,certificate_status='issued',issued_at=now(),error=NULL
    WHERE tenant_id=p_tenant AND id=p_id AND status='active' AND pdf_path IS NULL
      AND certificate_template_id IS NOT NULL AND certificate_status IN ('pending','error');
  RETURN FOUND;
END $$;

CREATE FUNCTION public.sync_speaker_recognition(p_tenant uuid,p_type text,p_event uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
  IF p_type='event' AND EXISTS(SELECT 1 FROM public.event WHERE id=p_event AND tenant_id=p_tenant AND is_training) THEN
    PERFORM public.sync_training_speaker_recognition(p_tenant,p_event);
  ELSE PERFORM public.sync_legacy_speaker_recognition(p_tenant,p_type,p_event);
  END IF;
END $$;
REVOKE ALL ON FUNCTION public.speaker_agenda_instant(date,time,text,boolean),
  public.process_training_speaker_awards(uuid,uuid,boolean),
  public.sync_training_speaker_recognition(uuid,uuid),public.sync_speaker_recognition(uuid,text,uuid)
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.process_training_speaker_awards(uuid,uuid,boolean),
  public.sync_speaker_recognition(uuid,text,uuid) TO service_role;
NOTIFY pgrst,'reload schema';
COMMIT;
