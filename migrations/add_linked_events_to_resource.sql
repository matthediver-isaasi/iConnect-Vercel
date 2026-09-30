-- Add linked_events JSONB column to resource table
-- Stores an array of objects: [{ event_id: "uuid", session_id: "uuid" (optional) }]
-- Used for event-linked access control: only members who attended linked events can see the resource

ALTER TABLE resource ADD COLUMN IF NOT EXISTS linked_events JSONB DEFAULT '[]'::jsonb;

CREATE INDEX IF NOT EXISTS idx_resource_linked_events ON resource USING gin(linked_events);

COMMENT ON COLUMN resource.linked_events IS 'JSON array of linked events/sessions for access control. Each entry: { event_id, session_id? }';
