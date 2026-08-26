-- Task #3767: Microsoft Teams attendance provider bindings.
-- A binding is the security boundary between an application attendance target,
-- one tenant-owned Outlook connection, its Microsoft organiser, and one stable
-- Graph onlineMeeting resource. Updating online_meeting_id deliberately replaces
-- the identity used by subsequent snapshots.
-- These are the canonical persisted meeting fields.  Keep them here rather
-- than in an ad-hoc root migration: event editors write these fields directly,
-- and the triggers below turn that write into the attendance work queue.
DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['event', 'complex_event_session', 'event_agenda_item']
  LOOP
    EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS online_provider text', table_name);
    EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS teams_online_meeting_id text', table_name);
    EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS teams_join_web_url text', table_name);
    EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS teams_organiser_microsoft_user_id text', table_name);
    EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS teams_organiser_email text', table_name);
    EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS teams_outlook_connection_id text', table_name);
    EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS teams_meeting_lifecycle text', table_name);
  END LOOP;
END $$;
CREATE INDEX IF NOT EXISTS idx_event_teams_online_meeting ON event(tenant_id, teams_online_meeting_id);
CREATE INDEX IF NOT EXISTS idx_session_teams_online_meeting ON complex_event_session(tenant_id, teams_online_meeting_id);
CREATE INDEX IF NOT EXISTS idx_agenda_teams_online_meeting ON event_agenda_item(tenant_id, teams_online_meeting_id);

CREATE TABLE IF NOT EXISTS teams_attendance_binding (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  target_type text NOT NULL CHECK (target_type IN ('event','complex_event_session','agenda_item')),
  target_id uuid NOT NULL,
  event_id uuid NOT NULL,
  outlook_connection_id text NOT NULL,
  organiser_microsoft_user_id text NOT NULL,
  online_meeting_id text NOT NULL,
  join_web_url text,
  scheduled_end_at timestamptz,
  enabled boolean NOT NULL DEFAULT true,
  last_sync_at timestamptz,
  last_attempt_at timestamptz,
  next_attempt_at timestamptz,
  attempt_count integer NOT NULL DEFAULT 0,
  terminal_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, target_type, target_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_teams_attendance_meeting_boundary
  ON teams_attendance_binding
  (tenant_id, outlook_connection_id, organiser_microsoft_user_id, online_meeting_id);
CREATE INDEX IF NOT EXISTS idx_teams_attendance_due
  ON teams_attendance_binding(enabled, scheduled_end_at, last_sync_at);

ALTER TABLE teams_attendance_binding ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS service_role_all ON teams_attendance_binding;
CREATE POLICY service_role_all ON teams_attendance_binding FOR ALL TO service_role
  USING (true) WITH CHECK (true);

-- Provider identity is useful to report consumers without provider-specific
-- joins. These nullable columns preserve existing Zoom rows.
ALTER TABLE attendance_target ADD COLUMN IF NOT EXISTS provider_connection_id text;
ALTER TABLE attendance_target ADD COLUMN IF NOT EXISTS provider_organiser_id text;

-- Mirror editor writes into the durable attendance queue.  A replacement or
-- detach immediately hides the old target: old facts can never be reported as
-- belonging to a newly-selected Teams meeting.  The successful-sync trigger
-- below atomically re-enables it in the report snapshot transaction.
CREATE OR REPLACE FUNCTION mirror_teams_attendance_binding()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_target_type text;
  v_event_id uuid;
  v_scheduled_end_at timestamptz;
  v_existing teams_attendance_binding%ROWTYPE;
  v_complete boolean;
BEGIN
  v_target_type := CASE TG_TABLE_NAME
    WHEN 'event' THEN 'event'
    WHEN 'complex_event_session' THEN 'complex_event_session'
    WHEN 'event_agenda_item' THEN 'agenda_item'
  END;
  v_event_id := CASE TG_TABLE_NAME
    WHEN 'event' THEN NEW.id
    WHEN 'complex_event_session' THEN NEW.complex_event_id
    WHEN 'event_agenda_item' THEN NEW.event_id
  END;
  v_scheduled_end_at := CASE TG_TABLE_NAME
    WHEN 'event' THEN NEW.end_date
    WHEN 'complex_event_session' THEN NEW.end_time
    WHEN 'event_agenda_item' THEN
      ((NEW.end_date::text || 'T' || COALESCE(NEW.end_time::text, '23:59:59'))::timestamp
        AT TIME ZONE COALESCE((SELECT e.timezone FROM event e WHERE e.id=NEW.event_id AND e.tenant_id=NEW.tenant_id), 'UTC'))
  END;
  v_complete := NEW.teams_online_meeting_id IS NOT NULL
    AND NEW.teams_outlook_connection_id IS NOT NULL
    AND NEW.teams_organiser_microsoft_user_id IS NOT NULL
    AND COALESCE(NEW.teams_meeting_lifecycle, 'active') NOT IN ('deleted','detached','cancelled')
    AND (NEW.online_provider IS NULL OR NEW.online_provider='teams');
  SELECT * INTO v_existing FROM teams_attendance_binding
    WHERE tenant_id=NEW.tenant_id AND target_type=v_target_type AND target_id=NEW.id
    FOR UPDATE;

  IF NOT v_complete THEN
    UPDATE teams_attendance_binding SET enabled=false, updated_at=now()
      WHERE tenant_id=NEW.tenant_id AND target_type=v_target_type AND target_id=NEW.id;
    UPDATE attendance_target SET tracking_enabled=false, updated_at=now()
      WHERE tenant_id=NEW.tenant_id AND provider='teams'
        AND target_type=v_target_type AND target_id=NEW.id;
    RETURN NEW;
  END IF;

  IF FOUND AND (
    v_existing.online_meeting_id IS DISTINCT FROM NEW.teams_online_meeting_id
    OR v_existing.outlook_connection_id IS DISTINCT FROM NEW.teams_outlook_connection_id
    OR v_existing.organiser_microsoft_user_id IS DISTINCT FROM NEW.teams_organiser_microsoft_user_id
  ) THEN
    UPDATE attendance_target SET tracking_enabled=false, updated_at=now()
      WHERE tenant_id=NEW.tenant_id AND provider='teams'
        AND target_type=v_target_type AND target_id=NEW.id;
  END IF;

  INSERT INTO teams_attendance_binding (
    tenant_id,target_type,target_id,event_id,outlook_connection_id,
    organiser_microsoft_user_id,online_meeting_id,join_web_url,scheduled_end_at,enabled,updated_at
  ) VALUES (
    NEW.tenant_id,v_target_type,NEW.id,v_event_id,NEW.teams_outlook_connection_id,
    NEW.teams_organiser_microsoft_user_id,NEW.teams_online_meeting_id,
    NEW.teams_join_web_url,v_scheduled_end_at,true,now()
  ) ON CONFLICT (tenant_id,target_type,target_id) DO UPDATE SET
    event_id=EXCLUDED.event_id, outlook_connection_id=EXCLUDED.outlook_connection_id,
    organiser_microsoft_user_id=EXCLUDED.organiser_microsoft_user_id,
    online_meeting_id=EXCLUDED.online_meeting_id, join_web_url=EXCLUDED.join_web_url,
    scheduled_end_at=EXCLUDED.scheduled_end_at, enabled=true, updated_at=now();
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION mirror_teams_attendance_binding() FROM PUBLIC;

DROP TRIGGER IF EXISTS mirror_event_teams_attendance_binding ON event;
CREATE TRIGGER mirror_event_teams_attendance_binding AFTER INSERT OR UPDATE OF
  teams_online_meeting_id, teams_join_web_url, teams_organiser_microsoft_user_id,
  teams_outlook_connection_id, teams_meeting_lifecycle, online_provider, end_date ON event
  FOR EACH ROW EXECUTE FUNCTION mirror_teams_attendance_binding();
DROP TRIGGER IF EXISTS mirror_session_teams_attendance_binding ON complex_event_session;
CREATE TRIGGER mirror_session_teams_attendance_binding AFTER INSERT OR UPDATE OF
  teams_online_meeting_id, teams_join_web_url, teams_organiser_microsoft_user_id,
  teams_outlook_connection_id, teams_meeting_lifecycle, online_provider, end_time ON complex_event_session
  FOR EACH ROW EXECUTE FUNCTION mirror_teams_attendance_binding();
DROP TRIGGER IF EXISTS mirror_agenda_teams_attendance_binding ON event_agenda_item;
CREATE TRIGGER mirror_agenda_teams_attendance_binding AFTER INSERT OR UPDATE OF
  teams_online_meeting_id, teams_join_web_url, teams_organiser_microsoft_user_id,
  teams_outlook_connection_id, teams_meeting_lifecycle, online_provider, end_date, end_time ON event_agenda_item
  FOR EACH ROW EXECUTE FUNCTION mirror_teams_attendance_binding();

-- Existing editor-created identities receive the same queue semantics during
-- rollout. A changed provider target is hidden until its first fresh snapshot.
-- Touch only targets that have an identity or an existing binding so detach
-- state is also reconciled during an idempotent rollout.
UPDATE event e SET teams_online_meeting_id=e.teams_online_meeting_id
WHERE e.teams_online_meeting_id IS NOT NULL OR EXISTS (
  SELECT 1 FROM teams_attendance_binding b
  WHERE b.tenant_id=e.tenant_id AND b.target_type='event' AND b.target_id=e.id
);
UPDATE complex_event_session s SET teams_online_meeting_id=s.teams_online_meeting_id
WHERE s.teams_online_meeting_id IS NOT NULL OR EXISTS (
  SELECT 1 FROM teams_attendance_binding b
  WHERE b.tenant_id=s.tenant_id AND b.target_type='complex_event_session' AND b.target_id=s.id
);
UPDATE event_agenda_item a SET teams_online_meeting_id=a.teams_online_meeting_id
WHERE a.teams_online_meeting_id IS NOT NULL OR EXISTS (
  SELECT 1 FROM teams_attendance_binding b
  WHERE b.tenant_id=a.tenant_id AND b.target_type='agenda_item' AND b.target_id=a.id
);
INSERT INTO teams_attendance_binding (
  tenant_id,target_type,target_id,event_id,outlook_connection_id,
  organiser_microsoft_user_id,online_meeting_id,join_web_url,scheduled_end_at,enabled
)
SELECT tenant_id,'event',id,id,teams_outlook_connection_id,
  teams_organiser_microsoft_user_id,teams_online_meeting_id,teams_join_web_url,end_date,true
FROM event WHERE teams_online_meeting_id IS NOT NULL
  AND teams_outlook_connection_id IS NOT NULL AND teams_organiser_microsoft_user_id IS NOT NULL
  AND COALESCE(teams_meeting_lifecycle, 'active') NOT IN ('deleted','detached','cancelled')
  AND (online_provider IS NULL OR online_provider='teams')
ON CONFLICT (tenant_id,target_type,target_id) DO UPDATE SET
  event_id=EXCLUDED.event_id, outlook_connection_id=EXCLUDED.outlook_connection_id,
  organiser_microsoft_user_id=EXCLUDED.organiser_microsoft_user_id,
  online_meeting_id=EXCLUDED.online_meeting_id, join_web_url=EXCLUDED.join_web_url,
  scheduled_end_at=EXCLUDED.scheduled_end_at, enabled=true, updated_at=now();
INSERT INTO teams_attendance_binding (
  tenant_id,target_type,target_id,event_id,outlook_connection_id,
  organiser_microsoft_user_id,online_meeting_id,join_web_url,scheduled_end_at,enabled
)
SELECT tenant_id,'complex_event_session',id,complex_event_id,teams_outlook_connection_id,
  teams_organiser_microsoft_user_id,teams_online_meeting_id,teams_join_web_url,end_time,true
FROM complex_event_session WHERE teams_online_meeting_id IS NOT NULL
  AND teams_outlook_connection_id IS NOT NULL AND teams_organiser_microsoft_user_id IS NOT NULL
  AND COALESCE(teams_meeting_lifecycle, 'active') NOT IN ('deleted','detached','cancelled')
  AND (online_provider IS NULL OR online_provider='teams')
ON CONFLICT (tenant_id,target_type,target_id) DO UPDATE SET
  event_id=EXCLUDED.event_id, outlook_connection_id=EXCLUDED.outlook_connection_id,
  organiser_microsoft_user_id=EXCLUDED.organiser_microsoft_user_id,
  online_meeting_id=EXCLUDED.online_meeting_id, join_web_url=EXCLUDED.join_web_url,
  scheduled_end_at=EXCLUDED.scheduled_end_at, enabled=true, updated_at=now();
INSERT INTO teams_attendance_binding (
  tenant_id,target_type,target_id,event_id,outlook_connection_id,
  organiser_microsoft_user_id,online_meeting_id,join_web_url,scheduled_end_at,enabled
)
SELECT tenant_id,'agenda_item',id,event_id,teams_outlook_connection_id,
  teams_organiser_microsoft_user_id,teams_online_meeting_id,teams_join_web_url,
  ((end_date::text || 'T' || COALESCE(end_time::text, '23:59:59'))::timestamp
    AT TIME ZONE COALESCE((SELECT e.timezone FROM event e WHERE e.id=event_agenda_item.event_id AND e.tenant_id=event_agenda_item.tenant_id), 'UTC')),true
FROM event_agenda_item WHERE teams_online_meeting_id IS NOT NULL
  AND teams_outlook_connection_id IS NOT NULL AND teams_organiser_microsoft_user_id IS NOT NULL
  AND COALESCE(teams_meeting_lifecycle, 'active') NOT IN ('deleted','detached','cancelled')
  AND (online_provider IS NULL OR online_provider='teams')
ON CONFLICT (tenant_id,target_type,target_id) DO UPDATE SET
  event_id=EXCLUDED.event_id, outlook_connection_id=EXCLUDED.outlook_connection_id,
  organiser_microsoft_user_id=EXCLUDED.organiser_microsoft_user_id,
  online_meeting_id=EXCLUDED.online_meeting_id, join_web_url=EXCLUDED.join_web_url,
  scheduled_end_at=EXCLUDED.scheduled_end_at, enabled=true, updated_at=now();
UPDATE attendance_target at SET tracking_enabled=false, updated_at=now()
FROM teams_attendance_binding b
WHERE at.tenant_id=b.tenant_id AND at.provider='teams'
  AND at.target_type=b.target_type AND at.target_id=b.target_id
  AND at.provider_target_id IS DISTINCT FROM b.online_meeting_id;

CREATE OR REPLACE FUNCTION enable_teams_target_after_success()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.provider='teams' AND NEW.status='succeeded' THEN
    UPDATE attendance_target SET tracking_enabled=true, updated_at=now()
      WHERE id=NEW.attendance_target_id AND tenant_id=NEW.tenant_id AND provider='teams';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION enable_teams_target_after_success() FROM PUBLIC;
DROP TRIGGER IF EXISTS enable_teams_target_after_success ON attendance_sync_run;
CREATE TRIGGER enable_teams_target_after_success AFTER INSERT OR UPDATE OF status ON attendance_sync_run
  FOR EACH ROW EXECUTE FUNCTION enable_teams_target_after_success();

-- Policy changes (including inherited parent policies and policy-row deletion)
-- immediately hide facts. Bindings remain as the retry/discovery source and a
-- later eligible sync re-enables a fresh snapshot.
CREATE OR REPLACE FUNCTION reconcile_teams_policy_change()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_tenant uuid; v_event uuid; v_target_type text; v_target_id uuid; v_owner_type text; v_owner_id uuid;
BEGIN
  IF TG_OP='DELETE' THEN
    v_tenant:=OLD.tenant_id;
    IF TG_TABLE_NAME IN ('complex_event','event') THEN v_event:=OLD.id; v_target_type:=NULL;
    ELSIF TG_TABLE_NAME='complex_event_session' THEN v_event:=OLD.complex_event_id; v_target_type:='complex_event_session'; v_target_id:=OLD.id;
    ELSIF TG_TABLE_NAME='event_agenda_item' THEN v_event:=OLD.event_id; v_target_type:='agenda_item'; v_target_id:=OLD.id;
    ELSE v_owner_type:=OLD.owner_type; v_owner_id:=OLD.owner_id;
    END IF;
  ELSE
    v_tenant:=NEW.tenant_id;
    IF TG_TABLE_NAME IN ('complex_event','event') THEN v_event:=NEW.id; v_target_type:=NULL;
    ELSIF TG_TABLE_NAME='complex_event_session' THEN v_event:=NEW.complex_event_id; v_target_type:='complex_event_session'; v_target_id:=NEW.id;
    ELSIF TG_TABLE_NAME='event_agenda_item' THEN v_event:=NEW.event_id; v_target_type:='agenda_item'; v_target_id:=NEW.id;
    ELSE v_owner_type:=NEW.owner_type; v_owner_id:=NEW.owner_id;
    END IF;
  END IF;
  IF v_owner_type IS NOT NULL THEN
    IF v_owner_type IN ('event','complex_event') THEN v_event:=v_owner_id;
    ELSIF v_owner_type='complex_event_session' THEN
      SELECT complex_event_id INTO v_event FROM complex_event_session WHERE id=v_owner_id AND tenant_id=v_tenant;
    ELSIF v_owner_type='agenda_item' THEN
      SELECT event_id INTO v_event FROM event_agenda_item WHERE id=v_owner_id AND tenant_id=v_tenant;
    END IF;
  END IF;
  IF v_event IS NOT NULL THEN
    -- A child override only invalidates its own snapshot. Parent changes
    -- invalidate all descendants because their effective inherited policy may
    -- have changed. Bindings remain lifecycle-enabled so eligible targets are
    -- queued/recoverable after a policy or consent change.
    UPDATE attendance_target SET tracking_enabled=false, updated_at=now()
      WHERE tenant_id=v_tenant AND provider='teams' AND event_id=v_event
        AND (v_target_type IS NULL OR (target_type=v_target_type AND target_id=v_target_id));
    IF TG_OP='DELETE' THEN
      UPDATE teams_attendance_binding SET enabled=false, updated_at=now()
        WHERE tenant_id=v_tenant AND event_id=v_event
          AND (v_target_type IS NULL OR (target_type=v_target_type AND target_id=v_target_id));
    ELSE
      UPDATE teams_attendance_binding SET enabled=true, next_attempt_at=NULL, updated_at=now()
        WHERE tenant_id=v_tenant AND event_id=v_event
          AND (v_target_type IS NULL OR (target_type=v_target_type AND target_id=v_target_id));
    END IF;
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS reconcile_event_teams_policy ON event;
CREATE TRIGGER reconcile_event_teams_policy AFTER UPDATE OF attendance_tracking_enabled,attendance_provider,attendance_threshold_minutes OR DELETE ON event
  FOR EACH ROW EXECUTE FUNCTION reconcile_teams_policy_change();
DROP TRIGGER IF EXISTS reconcile_complex_event_teams_policy ON complex_event;
CREATE TRIGGER reconcile_complex_event_teams_policy AFTER UPDATE OF attendance_tracking_enabled,attendance_provider,attendance_threshold_minutes OR DELETE ON complex_event
  FOR EACH ROW EXECUTE FUNCTION reconcile_teams_policy_change();
DROP TRIGGER IF EXISTS reconcile_session_teams_policy ON complex_event_session;
CREATE TRIGGER reconcile_session_teams_policy AFTER UPDATE OF attendance_tracking_enabled,attendance_provider,attendance_threshold_minutes,attendance_policy_override OR DELETE ON complex_event_session
  FOR EACH ROW EXECUTE FUNCTION reconcile_teams_policy_change();
DROP TRIGGER IF EXISTS reconcile_agenda_teams_policy ON event_agenda_item;
CREATE TRIGGER reconcile_agenda_teams_policy AFTER UPDATE OF attendance_tracking_enabled,attendance_provider,attendance_threshold_minutes,attendance_policy_override OR DELETE ON event_agenda_item
  FOR EACH ROW EXECUTE FUNCTION reconcile_teams_policy_change();
-- Policy snapshots are written during report persistence; a trigger here would
-- hide the very snapshot being atomically committed. Entity policy triggers
-- above are the authoritative lifecycle reconciliation path.
DROP TRIGGER IF EXISTS reconcile_policy_row_teams_policy ON attendance_policy;

REVOKE ALL ON teams_attendance_binding FROM anon, authenticated;
REVOKE ALL ON FUNCTION mirror_teams_attendance_binding() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION enable_teams_target_after_success() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION reconcile_teams_policy_change() FROM PUBLIC, anon, authenticated;