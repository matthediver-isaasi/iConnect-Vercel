-- Event-specific sponsor detail: optional free-text note describing what a
-- sponsor is sponsoring for a particular event (e.g. "Lunch", "Drinks
-- reception"). Lives on the per-event assignment, not the master sponsor.
ALTER TABLE event_sponsor_assignment
  ADD COLUMN IF NOT EXISTS sponsorship_detail TEXT;
