-- Repair provider fields expected by the simple-event, complex-session, and
-- training-agenda editors. This intentionally repeats the additive portion of
-- 20260830_teams_attendance.sql so environments that missed that migration can
-- recover safely, including environments where only some columns were added.

DO $$
DECLARE
  event_table text;
BEGIN
  FOREACH event_table IN ARRAY ARRAY[
    'event',
    'complex_event_session',
    'event_agenda_item'
  ]
  LOOP
    EXECUTE format(
      'ALTER TABLE %I ADD COLUMN IF NOT EXISTS online_provider text',
      event_table
    );
    EXECUTE format(
      'ALTER TABLE %I ADD COLUMN IF NOT EXISTS teams_online_meeting_id text',
      event_table
    );
    EXECUTE format(
      'ALTER TABLE %I ADD COLUMN IF NOT EXISTS teams_join_web_url text',
      event_table
    );
    EXECUTE format(
      'ALTER TABLE %I ADD COLUMN IF NOT EXISTS teams_organiser_microsoft_user_id text',
      event_table
    );
    EXECUTE format(
      'ALTER TABLE %I ADD COLUMN IF NOT EXISTS teams_organiser_email text',
      event_table
    );
    EXECUTE format(
      'ALTER TABLE %I ADD COLUMN IF NOT EXISTS teams_outlook_connection_id text',
      event_table
    );
    EXECUTE format(
      'ALTER TABLE %I ADD COLUMN IF NOT EXISTS teams_meeting_lifecycle text',
      event_table
    );
  END LOOP;
END $$;

CREATE INDEX IF NOT EXISTS idx_event_teams_online_meeting
  ON event (tenant_id, teams_online_meeting_id);
CREATE INDEX IF NOT EXISTS idx_session_teams_online_meeting
  ON complex_event_session (tenant_id, teams_online_meeting_id);
CREATE INDEX IF NOT EXISTS idx_agenda_teams_online_meeting
  ON event_agenda_item (tenant_id, teams_online_meeting_id);

NOTIFY pgrst, 'reload schema';