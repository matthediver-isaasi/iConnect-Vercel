-- Task 3419: Training events with multi-day agenda
-- 1. is_training flag on event (simple-event stack reuse)
-- 2. event_agenda_item child table (one row per agenda day/date-range line)

ALTER TABLE event ADD COLUMN IF NOT EXISTS is_training boolean NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS event_agenda_item (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  event_id uuid NOT NULL REFERENCES event(id) ON DELETE CASCADE,
  start_date date NOT NULL,
  end_date date,
  description text,
  item_type text,                -- name from the tenant 'event_agenda_item_types' setting
  location text,                 -- required when item_type behaves as "In person"
  zoom_webinar_id uuid,          -- local zoom_webinar PK (Online lines)
  zoom_meeting_id uuid,          -- local zoom_meeting PK (Online lines)
  lms_url text,                  -- Self study external LMS link
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_event_agenda_item_event ON event_agenda_item(event_id);
CREATE INDEX IF NOT EXISTS idx_event_agenda_item_tenant ON event_agenda_item(tenant_id);
