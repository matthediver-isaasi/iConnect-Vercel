-- Task #3266: optional admin-written explainer shown with the day count on
-- event cards / detail page when a complex event's days are non-consecutive.
ALTER TABLE complex_event
  ADD COLUMN IF NOT EXISTS custom_duration_explainer text;
