-- Task #1144: Group Events feature.
-- Mirrors Group Projects (#1133): member groups can be flagged
-- events_enabled with a per-group events_enabled_roles list. Events can be
-- linked back to a member_group; group events carry an optional pasted
-- meeting URL and have their own RSVP table. Idempotent.

ALTER TABLE member_group
  ADD COLUMN IF NOT EXISTS events_enabled BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE member_group
  ADD COLUMN IF NOT EXISTS events_enabled_roles TEXT[] NOT NULL DEFAULT '{}'::text[];

ALTER TABLE event
  ADD COLUMN IF NOT EXISTS member_group_id UUID NULL REFERENCES member_group(id) ON DELETE SET NULL;

ALTER TABLE event
  ADD COLUMN IF NOT EXISTS online_meeting_url TEXT NULL;

CREATE INDEX IF NOT EXISTS idx_event_member_group_id
  ON event(member_group_id)
  WHERE member_group_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS event_rsvp (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id UUID NOT NULL REFERENCES event(id) ON DELETE CASCADE,
  identity_id TEXT NOT NULL REFERENCES tenant_identity(id) ON DELETE CASCADE,
  tenant_id UUID NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  response TEXT NOT NULL CHECK (response IN ('going','not_going','maybe')),
  responded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT event_rsvp_event_identity_unique UNIQUE (event_id, identity_id)
);

CREATE INDEX IF NOT EXISTS idx_event_rsvp_event_id ON event_rsvp(event_id);
CREATE INDEX IF NOT EXISTS idx_event_rsvp_identity_id ON event_rsvp(identity_id);
CREATE INDEX IF NOT EXISTS idx_event_rsvp_tenant_id ON event_rsvp(tenant_id);

ALTER TABLE event_rsvp
  ADD COLUMN IF NOT EXISTS reminder_sent_at TIMESTAMPTZ NULL;
