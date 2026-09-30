-- Task 3443: per-agenda-item start/end times for Training events.
-- Nullable so existing date-only rows keep working (times default sensibly
-- in application code: start 00:00, end 23:59 when unset).

ALTER TABLE event_agenda_item ADD COLUMN IF NOT EXISTS start_time time;
ALTER TABLE event_agenda_item ADD COLUMN IF NOT EXISTS end_time time;
