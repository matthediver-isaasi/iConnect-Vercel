-- Task #1659: Vacancy closing dates.
--
-- vacancy.closing_date — optional date after which a vacancy is treated as
-- closed (in addition to an explicit status='closed'). Closure is derived at
-- read time from this date; the stored `status` field is left untouched.
-- Idempotent; safe to re-run.

ALTER TABLE vacancy
  ADD COLUMN IF NOT EXISTS closing_date DATE;
