-- Manual case-study tracking status on article_brief.
--
-- A simple editor-set field, independent of the existing case-study
-- permission-form workflow and the `case_study_required` toggle. Three
-- values: 'none' (No case study, the default), 'prepared', 'submitted'.
-- Purely informational + filterable; triggers no workflows or emails.

ALTER TABLE article_brief
  ADD COLUMN IF NOT EXISTS case_study_status TEXT NOT NULL DEFAULT 'none';

ALTER TABLE article_brief
  DROP CONSTRAINT IF EXISTS article_brief_case_study_status_check;

ALTER TABLE article_brief
  ADD CONSTRAINT article_brief_case_study_status_check
  CHECK (case_study_status IN ('none', 'prepared', 'submitted'));
