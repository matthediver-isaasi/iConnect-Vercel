-- Brief-level Copyright Assignment form workflow.
--
-- Replaces the case-study-scoped copyright slot (added in
-- migrations/add_case_study_copyright_form.sql) with new brief-level columns
-- on article_brief so the copyright form can be sent to the brief's assigned
-- writer regardless of whether the brief has a case study.
--
-- 1) Add the new brief-level copyright columns.
-- 2) Copy any existing case-study copyright values onto the new columns,
--    flagging copyright_required = true wherever a copyright form id was set.
-- 3) Drop the three old case-study copyright columns.

ALTER TABLE article_brief
  ADD COLUMN IF NOT EXISTS copyright_required BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE article_brief
  ADD COLUMN IF NOT EXISTS copyright_form_id UUID REFERENCES form(id);
ALTER TABLE article_brief
  ADD COLUMN IF NOT EXISTS copyright_form_sent_at TIMESTAMPTZ;
ALTER TABLE article_brief
  ADD COLUMN IF NOT EXISTS copyright_submission_id UUID REFERENCES form_submission(id);

-- Copy legacy case-study copyright values onto the new brief-level columns.
-- Guarded with column existence checks so this migration is idempotent.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'article_brief'
      AND column_name = 'case_study_copyright_form_id'
  ) THEN
    UPDATE article_brief
    SET copyright_form_id = COALESCE(copyright_form_id, case_study_copyright_form_id),
        copyright_form_sent_at = COALESCE(copyright_form_sent_at, case_study_copyright_form_sent_at),
        copyright_submission_id = COALESCE(copyright_submission_id, case_study_copyright_submission_id),
        copyright_required = copyright_required OR (case_study_copyright_form_id IS NOT NULL)
    WHERE case_study_copyright_form_id IS NOT NULL
       OR case_study_copyright_form_sent_at IS NOT NULL
       OR case_study_copyright_submission_id IS NOT NULL;
  END IF;
END$$;

ALTER TABLE article_brief DROP COLUMN IF EXISTS case_study_copyright_submission_id;
ALTER TABLE article_brief DROP COLUMN IF EXISTS case_study_copyright_form_sent_at;
ALTER TABLE article_brief DROP COLUMN IF EXISTS case_study_copyright_form_id;

CREATE INDEX IF NOT EXISTS idx_article_brief_copyright_form ON article_brief(copyright_form_id);
CREATE INDEX IF NOT EXISTS idx_article_brief_copyright_submission ON article_brief(copyright_submission_id);
