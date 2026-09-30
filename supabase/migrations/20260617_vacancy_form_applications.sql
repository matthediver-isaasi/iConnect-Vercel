-- Task #1539: Vacancy editing + form-based applications.
--
-- 1. form.is_job_posting        — flags a form as a "Job posting" application
--                                 form so it appears in the vacancy form picker.
-- 2. vacancy.application_form_id — optional link from a vacancy to the Form used
--                                 to collect applications (NULL keeps the legacy
--                                 "express interest" message-only behaviour).
-- 3. vacancy.applicants_viewed_at — timestamp the group admin last opened the
--                                 submissions modal; drives the "new entry"
--                                 indicator on the posting card.
-- 4. form_submission.vacancy_id  — links a public form submission back to the
--                                 vacancy it was submitted against (mirrors the
--                                 brief linking pattern).
-- Idempotent; safe to re-run.

ALTER TABLE form
  ADD COLUMN IF NOT EXISTS is_job_posting BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE vacancy
  ADD COLUMN IF NOT EXISTS application_form_id UUID REFERENCES form(id) ON DELETE SET NULL;

ALTER TABLE vacancy
  ADD COLUMN IF NOT EXISTS applicants_viewed_at TIMESTAMP WITH TIME ZONE;

ALTER TABLE form_submission
  ADD COLUMN IF NOT EXISTS vacancy_id UUID REFERENCES vacancy(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_form_submission_vacancy ON form_submission(vacancy_id);
CREATE INDEX IF NOT EXISTS idx_vacancy_application_form ON vacancy(application_form_id);
