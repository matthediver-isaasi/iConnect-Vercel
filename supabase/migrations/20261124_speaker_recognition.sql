-- Task 4838. Separate from the member badge/voucher ledger: never backfill
-- recognition from skipped grants, never create a member or send an email.
CREATE TABLE IF NOT EXISTS public.speaker_recognition_policy (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  starts_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
INSERT INTO public.speaker_recognition_policy(singleton) VALUES (true) ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS public.speaker_recognition (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenant(id) ON DELETE CASCADE,
  event_type text NOT NULL CHECK (event_type IN ('event','complex_event')),
  event_id uuid NOT NULL,
  speaker_id uuid NOT NULL,
  member_id uuid,
  grant_id uuid,
  badge_id uuid,
  member_badge_id uuid,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked')),
  certificate_status text NOT NULL DEFAULT 'unavailable'
    CHECK (certificate_status IN ('unavailable','pending','issued','error')),
  certificate_template_id uuid,
  snapshot jsonb NOT NULL,
  pdf_path text,
  pdf_sha256 text,
  error text,
  last_attempt_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  issued_at timestamptz,
  revoked_at timestamptz,
  UNIQUE (tenant_id,event_type,event_id,speaker_id),
  CHECK ((pdf_path IS NULL) = (pdf_sha256 IS NULL))
);
CREATE INDEX IF NOT EXISTS speaker_recognition_member_history
  ON public.speaker_recognition(tenant_id,member_id,created_at DESC,id);
CREATE INDEX IF NOT EXISTS speaker_recognition_speaker_history
  ON public.speaker_recognition(tenant_id,speaker_id,created_at DESC,id);
ALTER TABLE public.speaker_recognition ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.speaker_recognition_policy ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.speaker_recognition,public.speaker_recognition_policy FROM anon,authenticated;
GRANT ALL ON public.speaker_recognition,public.speaker_recognition_policy TO service_role;
ALTER TABLE public.event ADD COLUMN IF NOT EXISTS speaker_recognition_processed_at timestamptz;
ALTER TABLE public.complex_event ADD COLUMN IF NOT EXISTS speaker_recognition_processed_at timestamptz;
INSERT INTO storage.buckets(id,name,public) VALUES ('speaker-certificates','speaker-certificates',false)
  ON CONFLICT (id) DO UPDATE SET public=false;
-- Restrictive guard also protects against pre-existing broad storage policies.
-- Only the service-backed, ownership-checked PDF endpoint may read this bucket.
DROP POLICY IF EXISTS speaker_certificates_service_only ON storage.objects;
CREATE POLICY speaker_certificates_service_only ON storage.objects AS RESTRICTIVE
  FOR ALL TO anon,authenticated
  USING (bucket_id <> 'speaker-certificates')
  WITH CHECK (bucket_id <> 'speaker-certificates');

-- Live references, including training agenda and complex sessions. A single
-- event lock serializes discovery, completion and removal.
CREATE OR REPLACE FUNCTION public.speaker_recognition_references(p_tenant uuid,p_type text,p_event uuid)
RETURNS TABLE(speaker_id uuid) LANGUAGE sql STABLE SET search_path=public AS $$
  SELECT s.id FROM speaker s WHERE s.tenant_id=p_tenant AND s.id::text IN (
    SELECT jsonb_array_elements_text(COALESCE(to_jsonb(e.speaker_ids),'[]'::jsonb)) FROM event e
      WHERE p_type='event' AND e.tenant_id=p_tenant AND e.id=p_event
    UNION
    SELECT jsonb_array_elements_text(COALESCE(to_jsonb(a.speaker_ids),'[]'::jsonb)) FROM event_agenda_item a
      WHERE p_type='event' AND a.tenant_id=p_tenant AND a.event_id=p_event
    UNION
    SELECT jsonb_array_elements_text(COALESCE(to_jsonb(s.speaker_ids),'[]'::jsonb)) FROM complex_event_session s
      WHERE p_type='complex_event' AND s.tenant_id=p_tenant AND s.complex_event_id=p_event
  )
$$;

CREATE OR REPLACE FUNCTION public.validate_speaker_certificate_config()
RETURNS trigger LANGUAGE plpgsql SET search_path=public AS $$
DECLARE selection jsonb; template_id text;
BEGIN
  IF TG_OP='UPDATE' AND NEW.speaker_award_config IS NOT DISTINCT FROM OLD.speaker_award_config THEN RETURN NEW; END IF;
  IF NEW.speaker_award_config IS NULL THEN RETURN NEW; END IF;
  FOR selection IN
    SELECT NEW.speaker_award_config->'default'
    UNION ALL SELECT value FROM jsonb_each(COALESCE(NEW.speaker_award_config->'overrides','{}'))
  LOOP
    template_id := selection->>'certificate_template_id';
    IF template_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM cpd_certificate_template t WHERE t.id::text=template_id
      AND t.tenant_id=NEW.tenant_id AND t.status='active'
    ) THEN RAISE EXCEPTION 'Speaker certificate template must be an active template in this tenant' USING ERRCODE='23514'; END IF;
  END LOOP;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS validate_speaker_certificate_config ON public.event;
CREATE TRIGGER validate_speaker_certificate_config BEFORE INSERT OR UPDATE ON public.event
  FOR EACH ROW EXECUTE FUNCTION public.validate_speaker_certificate_config();
DROP TRIGGER IF EXISTS validate_speaker_certificate_config ON public.complex_event;
CREATE TRIGGER validate_speaker_certificate_config BEFORE INSERT OR UPDATE ON public.complex_event
  FOR EACH ROW EXECUTE FUNCTION public.validate_speaker_certificate_config();

-- No mutable source value is accepted from the caller. Snapshots include the
-- original recipient, template source hash and designer fields.
CREATE OR REPLACE FUNCTION public.sync_speaker_recognition(p_tenant uuid,p_type text,p_event uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE e jsonb; cfg jsonb; o jsonb; s record; g speaker_award_grant%ROWTYPE;
  b jsonb; t jsonb; fields jsonb; bid uuid; tid uuid; recipient uuid; due boolean; cutoff timestamptz;
BEGIN
  IF p_type NOT IN ('event','complex_event') THEN RAISE EXCEPTION 'Invalid event type'; END IF;
  EXECUTE format('SELECT to_jsonb(e) FROM public.%I e WHERE tenant_id=$1 AND id=$2 FOR UPDATE',p_type)
    INTO e USING p_tenant,p_event;
  IF e IS NULL THEN RETURN; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(p_tenant::text||p_type||p_event::text,4838));
  cfg:=e->'speaker_award_config';
  due:=(e->>'start_date')::timestamptz <= now();
  SELECT starts_at INTO cutoff FROM speaker_recognition_policy WHERE singleton;
  UPDATE speaker_recognition r SET status='revoked',revoked_at=COALESCE(revoked_at,now())
    WHERE tenant_id=p_tenant AND event_type=p_type AND event_id=p_event
      AND (NOT EXISTS (SELECT 1 FROM speaker_recognition_references(p_tenant,p_type,p_event) refs WHERE refs.speaker_id=r.speaker_id)
        OR e->>'status'<>'published' OR e->>'event_state'='draft'
        OR (r.pdf_path IS NULL AND r.certificate_template_id IS NOT NULL AND
          (cfg->>'enabled' IS DISTINCT FROM 'true' OR cfg->'overrides'->r.speaker_id::text->>'excluded'='true')));
  -- Cancelling a pending certificate must not cancel a successfully awarded
  -- badge. Keep its immutable certificate intent for audit, but remove it from
  -- the issuance queue. Completion performs this same live-policy check.
  UPDATE speaker_recognition r SET certificate_status='unavailable',
    error='Certificate disabled before issuance'
    WHERE tenant_id=p_tenant AND event_type=p_type AND event_id=p_event
      AND pdf_path IS NULL AND certificate_template_id IS NOT NULL
      AND (cfg->>'enabled' IS DISTINCT FROM 'true'
        OR cfg->'overrides'->r.speaker_id::text->>'excluded'='true'
        OR CASE WHEN COALESCE(cfg->'overrides'->r.speaker_id::text,'{}') ? 'certificate_template_id'
          THEN NULLIF(cfg->'overrides'->r.speaker_id::text->>'certificate_template_id','')
          ELSE NULLIF(cfg->'default'->>'certificate_template_id','') END IS NULL);
  -- The deployment boundary intentionally excludes all already-started events.
  IF (e->>'start_date')::timestamptz < cutoff OR e->>'status'<>'published'
    OR e->>'event_state'='draft' THEN RETURN; END IF;
  IF cfg->>'enabled' IS DISTINCT FROM 'true' THEN
    IF due THEN EXECUTE format('UPDATE public.%I SET speaker_recognition_processed_at=now() WHERE tenant_id=$1 AND id=$2',p_type) USING p_tenant,p_event; END IF;
    RETURN;
  END IF;
  FOR s IN SELECT sp.* FROM speaker sp JOIN speaker_recognition_references(p_tenant,p_type,p_event) refs ON refs.speaker_id=sp.id LOOP
    o:=COALESCE(cfg->'overrides'->s.id::text,'{}');
    IF o->>'excluded'='true' THEN CONTINUE; END IF;
    tid:=CASE WHEN o ? 'certificate_template_id' THEN NULLIF(o->>'certificate_template_id','')::uuid
      ELSE NULLIF(cfg->'default'->>'certificate_template_id','')::uuid END;
    bid:=COALESCE(NULLIF(o->>'badge_id',''),NULLIF(cfg->'default'->>'badge_id',''))::uuid;
    IF due IS DISTINCT FROM true THEN tid:=NULL;
    ELSIF tid IS NOT NULL AND e->>'speaker_recognition_processed_at' IS NOT NULL THEN
      -- Once event-start recognition has been captured, later configuration
      -- edits or late additions cannot retrospectively create certificates.
      SELECT certificate_template_id INTO tid FROM speaker_recognition
        WHERE tenant_id=p_tenant AND event_type=p_type AND event_id=p_event AND speaker_id=s.id;
    END IF;
    IF due IS DISTINCT FROM true AND COALESCE(cfg->>'badge_timing','event_start')<>'on_assignment' THEN bid:=NULL; END IF;
    SELECT * INTO g FROM speaker_award_grant WHERE tenant_id=p_tenant AND event_type=p_type AND event_id=p_event AND speaker_id=s.id;
    recipient:=COALESCE(g.member_id,s.member_id);
    -- Member recognition must have real member-badge evidence. External badge
    -- recognition is independent and never fakes member-badge eligibility.
    IF recipient IS NOT NULL THEN
      bid:=CASE WHEN g.member_badge_id IS NOT NULL THEN g.badge_id ELSE NULL END;
    END IF;
    IF recipient IS NULL AND due AND e->>'speaker_recognition_processed_at' IS NOT NULL
      AND COALESCE(cfg->>'badge_timing','event_start')<>'on_assignment' THEN
      SELECT badge_id INTO bid FROM speaker_recognition
        WHERE tenant_id=p_tenant AND event_type=p_type AND event_id=p_event AND speaker_id=s.id;
    END IF;
    SELECT to_jsonb(badge) INTO b FROM badge WHERE tenant_id=p_tenant AND id=bid;
    IF b IS NULL THEN bid:=NULL; END IF;
    IF tid IS NULL AND bid IS NULL THEN CONTINUE; END IF;
    SELECT to_jsonb(ct) INTO t FROM cpd_certificate_template ct WHERE tenant_id=p_tenant AND id=tid;
    SELECT COALESCE(jsonb_agg(to_jsonb(p) ORDER BY page_number,display_order,p.id),'[]') INTO fields
      FROM cpd_certificate_placeholder p WHERE tenant_id=p_tenant AND template_id=tid;
    INSERT INTO speaker_recognition(tenant_id,event_type,event_id,speaker_id,member_id,grant_id,badge_id,member_badge_id,
      certificate_template_id,certificate_status,snapshot)
    VALUES (p_tenant,p_type,p_event,s.id,recipient,g.id,bid,g.member_badge_id,tid,
      CASE WHEN tid IS NULL THEN 'unavailable' ELSE 'pending' END,
      jsonb_build_object('speaker_name',s.full_name,'speaker_email',s.email,'organization',s.organization,
        'event_title',e->>'title','event_start_date',e->>'start_date','event_end_date',e->>'end_date','event_timezone',e->>'timezone',
        'badge',b,'badge_evidence',CASE WHEN recipient IS NULL THEN 'speaker_recognition' ELSE 'member_badge' END,
        'template',t,'placeholders',fields,'member_id',recipient))
    ON CONFLICT (tenant_id,event_type,event_id,speaker_id) DO UPDATE SET
      -- Re-additions retain original identity and artifact. Changed ownership
      -- never inherits an old recipient's recognition.
      status=CASE WHEN speaker_recognition.member_id IS NOT DISTINCT FROM EXCLUDED.member_id THEN 'active' ELSE speaker_recognition.status END,
      revoked_at=CASE WHEN speaker_recognition.member_id IS NOT DISTINCT FROM EXCLUDED.member_id THEN NULL ELSE speaker_recognition.revoked_at END,
      -- A member badge can succeed after the independent certificate already
      -- did. Refresh real grant evidence, never the immutable certificate
      -- snapshot, and never award a second badge here.
      badge_id=CASE WHEN speaker_recognition.member_id=EXCLUDED.member_id AND EXCLUDED.member_badge_id IS NOT NULL
        THEN EXCLUDED.badge_id ELSE speaker_recognition.badge_id END,
      member_badge_id=CASE WHEN speaker_recognition.member_id=EXCLUDED.member_id AND EXCLUDED.member_badge_id IS NOT NULL
        THEN EXCLUDED.member_badge_id ELSE speaker_recognition.member_badge_id END,
      grant_id=CASE WHEN speaker_recognition.member_id=EXCLUDED.member_id AND EXCLUDED.member_badge_id IS NOT NULL
        THEN EXCLUDED.grant_id ELSE speaker_recognition.grant_id END,
      certificate_template_id=CASE WHEN speaker_recognition.certificate_template_id IS NULL AND speaker_recognition.member_id IS NOT DISTINCT FROM EXCLUDED.member_id
        THEN EXCLUDED.certificate_template_id ELSE speaker_recognition.certificate_template_id END,
      certificate_status=CASE WHEN EXCLUDED.certificate_template_id IS NOT NULL
        AND (speaker_recognition.certificate_template_id IS NULL OR speaker_recognition.certificate_status='unavailable')
        AND speaker_recognition.member_id IS NOT DISTINCT FROM EXCLUDED.member_id THEN 'pending' ELSE speaker_recognition.certificate_status END,
      snapshot=CASE WHEN speaker_recognition.certificate_template_id IS NULL AND EXCLUDED.certificate_template_id IS NOT NULL
        AND speaker_recognition.member_id IS NOT DISTINCT FROM EXCLUDED.member_id
        THEN EXCLUDED.snapshot
        ELSE speaker_recognition.snapshot END;
  END LOOP;
  IF due THEN EXECUTE format('UPDATE public.%I SET speaker_recognition_processed_at=now() WHERE tenant_id=$1 AND id=$2',p_type) USING p_tenant,p_event; END IF;
END $$;

-- Completion is serialized with discovery/removal. Immutable artifacts cannot
-- be swapped out by a retry, and a revoked row cannot become issued.
CREATE OR REPLACE FUNCTION public.finish_speaker_certificate(p_tenant uuid,p_id uuid,p_path text,p_sha256 text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE r speaker_recognition%ROWTYPE;
BEGIN
  SELECT * INTO r FROM speaker_recognition WHERE tenant_id=p_tenant AND id=p_id;
  IF NOT FOUND THEN RETURN false; END IF;
  PERFORM sync_speaker_recognition(p_tenant,r.event_type,r.event_id);
  IF p_path <> p_tenant::text||'/'||p_id::text||'.pdf' OR p_sha256 !~ '^[a-f0-9]{64}$' THEN RAISE EXCEPTION 'Invalid artifact reference'; END IF;
  UPDATE speaker_recognition SET pdf_path=p_path,pdf_sha256=p_sha256,certificate_status='issued',issued_at=now(),error=NULL
    WHERE tenant_id=p_tenant AND id=p_id AND status='active' AND pdf_path IS NULL
      AND certificate_template_id IS NOT NULL AND certificate_status IN ('pending','error');
  RETURN FOUND;
END $$;
REVOKE ALL ON FUNCTION public.speaker_recognition_references(uuid,text,uuid),
  public.sync_speaker_recognition(uuid,text,uuid),public.finish_speaker_certificate(uuid,uuid,text,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.speaker_recognition_references(uuid,text,uuid),
  public.sync_speaker_recognition(uuid,text,uuid),public.finish_speaker_certificate(uuid,uuid,text,text) TO service_role;

-- This repair queue is independent of both event completion markers and PDF
-- retries. It only attaches existing member-badge evidence; it cannot create
-- grants, badges, vouchers or notification jobs.
CREATE OR REPLACE FUNCTION public.refresh_speaker_recognition_badges()
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE refreshed integer:=0;
BEGIN
  WITH candidates AS (
    SELECT a.id,g.id AS grant_id,g.badge_id,g.member_badge_id FROM speaker_recognition a
    JOIN speaker_award_grant g ON g.tenant_id=a.tenant_id AND g.event_type=a.event_type
      AND g.event_id=a.event_id AND g.speaker_id=a.speaker_id AND g.member_id=a.member_id
    JOIN badge b ON b.tenant_id=g.tenant_id AND b.id=g.badge_id
    WHERE g.member_badge_id IS NOT NULL
      AND (a.member_badge_id IS DISTINCT FROM g.member_badge_id OR a.badge_id IS DISTINCT FROM g.badge_id)
    ORDER BY a.id LIMIT 100
  )
  UPDATE speaker_recognition a SET grant_id=c.grant_id,badge_id=c.badge_id,member_badge_id=c.member_badge_id
    FROM candidates c WHERE a.id=c.id;
  GET DIAGNOSTICS refreshed=ROW_COUNT;
  RETURN refreshed;
END $$;
REVOKE ALL ON FUNCTION public.refresh_speaker_recognition_badges() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.refresh_speaker_recognition_badges() TO service_role;

-- Reference edits serialize with certificate completion, even if an editor
-- crashes before calling reconciliation. This trigger revokes only; it cannot
-- grant recognition, send email or generate a PDF.
CREATE OR REPLACE FUNCTION public.revoke_detached_speaker_recognition()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE row_data jsonb; old_data jsonb; typ text; eid uuid; tid uuid; previous_event uuid; previous_tenant uuid;
BEGIN
  row_data:=CASE WHEN TG_OP='DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END;
  old_data:=CASE WHEN TG_OP='UPDATE' THEN to_jsonb(OLD) ELSE NULL END;
  typ:=CASE WHEN TG_TABLE_NAME IN ('event','event_agenda_item') THEN 'event' ELSE 'complex_event' END;
  eid:=CASE WHEN TG_TABLE_NAME IN ('event','complex_event') THEN (row_data->>'id')::uuid
    WHEN typ='event' THEN (row_data->>'event_id')::uuid ELSE (row_data->>'complex_event_id')::uuid END;
  tid:=(row_data->>'tenant_id')::uuid;
  previous_event:=CASE WHEN TG_TABLE_NAME='event_agenda_item' THEN (old_data->>'event_id')::uuid
    WHEN TG_TABLE_NAME='complex_event_session' THEN (old_data->>'complex_event_id')::uuid ELSE eid END;
  previous_tenant:=(old_data->>'tenant_id')::uuid;
  PERFORM pg_advisory_xact_lock(hashtextextended(tid::text||typ||eid::text,4838));
  UPDATE speaker_recognition r SET status='revoked',revoked_at=COALESCE(revoked_at,now())
    WHERE tenant_id=tid AND event_type=typ AND event_id=eid
    AND (NOT EXISTS (SELECT 1 FROM speaker_recognition_references(tid,typ,eid) refs WHERE refs.speaker_id=r.speaker_id)
      OR (TG_TABLE_NAME IN ('event','complex_event') AND
        (TG_OP='DELETE' OR row_data->>'status'<>'published' OR row_data->>'event_state'='draft')));
  IF previous_event IS NOT NULL AND (previous_event<>eid OR previous_tenant<>tid) THEN
    PERFORM pg_advisory_xact_lock(hashtextextended(previous_tenant::text||typ||previous_event::text,4838));
    UPDATE speaker_recognition r SET status='revoked',revoked_at=COALESCE(revoked_at,now())
      WHERE tenant_id=previous_tenant AND event_type=typ AND event_id=previous_event
      AND NOT EXISTS (SELECT 1 FROM speaker_recognition_references(previous_tenant,typ,previous_event) refs WHERE refs.speaker_id=r.speaker_id);
  END IF;
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS revoke_detached_speaker_recognition ON public.event;
CREATE TRIGGER revoke_detached_speaker_recognition AFTER UPDATE OF speaker_ids,status,event_state OR DELETE ON public.event
  FOR EACH ROW EXECUTE FUNCTION public.revoke_detached_speaker_recognition();
DROP TRIGGER IF EXISTS revoke_detached_speaker_recognition ON public.complex_event;
CREATE TRIGGER revoke_detached_speaker_recognition AFTER UPDATE OF status,event_state OR DELETE ON public.complex_event
  FOR EACH ROW EXECUTE FUNCTION public.revoke_detached_speaker_recognition();
DROP TRIGGER IF EXISTS revoke_detached_speaker_recognition ON public.event_agenda_item;
CREATE TRIGGER revoke_detached_speaker_recognition AFTER UPDATE OR DELETE ON public.event_agenda_item
  FOR EACH ROW EXECUTE FUNCTION public.revoke_detached_speaker_recognition();
DROP TRIGGER IF EXISTS revoke_detached_speaker_recognition ON public.complex_event_session;
CREATE TRIGGER revoke_detached_speaker_recognition AFTER UPDATE OR DELETE ON public.complex_event_session
  FOR EACH ROW EXECUTE FUNCTION public.revoke_detached_speaker_recognition();

CREATE OR REPLACE FUNCTION public.protect_speaker_recognition_snapshot()
RETURNS trigger LANGUAGE plpgsql SET search_path=public AS $$
BEGIN
  IF ROW(NEW.id,NEW.tenant_id,NEW.event_type,NEW.event_id,NEW.speaker_id,NEW.member_id,NEW.created_at)
    IS DISTINCT FROM ROW(OLD.id,OLD.tenant_id,OLD.event_type,OLD.event_id,OLD.speaker_id,OLD.member_id,OLD.created_at) THEN
    RAISE EXCEPTION 'Speaker recognition recipient and provenance are immutable';
  END IF;
  IF OLD.certificate_template_id IS NOT NULL AND
    (NEW.snapshot IS DISTINCT FROM OLD.snapshot OR NEW.certificate_template_id IS DISTINCT FROM OLD.certificate_template_id) THEN
    RAISE EXCEPTION 'Speaker certificate issuance snapshot is immutable';
  END IF;
  IF OLD.pdf_path IS NOT NULL AND ROW(NEW.pdf_path,NEW.pdf_sha256,NEW.issued_at,NEW.certificate_status)
    IS DISTINCT FROM ROW(OLD.pdf_path,OLD.pdf_sha256,OLD.issued_at,OLD.certificate_status) THEN
    RAISE EXCEPTION 'Issued speaker certificate artifact is immutable';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS protect_speaker_recognition_snapshot ON public.speaker_recognition;
CREATE TRIGGER protect_speaker_recognition_snapshot BEFORE UPDATE ON public.speaker_recognition
  FOR EACH ROW EXECUTE FUNCTION public.protect_speaker_recognition_snapshot();
REVOKE ALL ON FUNCTION public.validate_speaker_certificate_config(),
  public.revoke_detached_speaker_recognition(),public.protect_speaker_recognition_snapshot() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.validate_speaker_certificate_config(),
  public.revoke_detached_speaker_recognition(),public.protect_speaker_recognition_snapshot() TO service_role;