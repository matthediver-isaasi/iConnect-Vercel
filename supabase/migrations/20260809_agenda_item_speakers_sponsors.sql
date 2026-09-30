-- Task 3436: per-agenda-item speakers and sponsors for Training events.
-- Additive to the event-level speaker_ids / event_sponsor_assignment rows.

ALTER TABLE event_agenda_item ADD COLUMN IF NOT EXISTS speaker_ids jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE event_agenda_item ADD COLUMN IF NOT EXISTS sponsor_ids jsonb NOT NULL DEFAULT '[]'::jsonb;
