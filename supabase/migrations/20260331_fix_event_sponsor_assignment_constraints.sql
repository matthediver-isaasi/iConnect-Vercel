ALTER TABLE event_sponsor_assignment
  ADD CONSTRAINT chk_event_type CHECK (event_type IN ('simple', 'complex'));

ALTER TABLE event_sponsor_assignment
  DROP CONSTRAINT IF EXISTS event_sponsor_assignment_event_id_sponsor_id_key;

ALTER TABLE event_sponsor_assignment
  ADD CONSTRAINT event_sponsor_assignment_event_sponsor_type_unique
  UNIQUE(tenant_id, event_id, event_type, sponsor_id);
