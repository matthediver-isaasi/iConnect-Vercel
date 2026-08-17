-- Add `height` column to dashboard_widget table.
-- Mirrors the existing `width` column: a short enum with a default of 'medium'
-- so all existing widgets behave identically to today (the medium sizes match
-- the current hard-coded chart heights).

ALTER TABLE dashboard_widget
  ADD COLUMN IF NOT EXISTS height varchar(10) NOT NULL DEFAULT 'medium';
