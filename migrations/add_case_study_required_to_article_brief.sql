-- Brief-level Case Study toggle.
--
-- Adds a `case_study_required` flag on article_brief that controls whether
-- the Case Study tab is visible on the brief detail page. The default is
-- false, but any brief that already has case-study data is backfilled to
-- true so existing in-flight case studies remain visible.

ALTER TABLE article_brief
  ADD COLUMN IF NOT EXISTS case_study_required BOOLEAN NOT NULL DEFAULT FALSE;

-- Backfill: turn the toggle on for any brief that already has case-study
-- data (a form selected, submission received, legacy content/images/
-- permissions, or any case-study upload row). Each JSONB check requires
-- non-empty content so briefs left with empty placeholders ({}, [])
-- are not flagged as having a case study.
DO $$
DECLARE
  has_uploads_table BOOLEAN := to_regclass('public.article_brief_case_study_upload') IS NOT NULL;
BEGIN
  IF has_uploads_table THEN
    UPDATE article_brief b
    SET case_study_required = TRUE
    WHERE case_study_required = FALSE
      AND (
        b.case_study_form_id IS NOT NULL
        OR b.case_study_submission_id IS NOT NULL
        OR (b.case_study_content IS NOT NULL AND b.case_study_content <> '')
        OR (
          b.case_study_images IS NOT NULL
          AND jsonb_typeof(b.case_study_images) = 'array'
          AND jsonb_array_length(b.case_study_images) > 0
        )
        OR (
          b.case_study_permissions IS NOT NULL
          AND (
            (jsonb_typeof(b.case_study_permissions) = 'object'
              AND (SELECT count(*) FROM jsonb_object_keys(b.case_study_permissions)) > 0)
            OR (jsonb_typeof(b.case_study_permissions) = 'array'
              AND jsonb_array_length(b.case_study_permissions) > 0)
            OR jsonb_typeof(b.case_study_permissions) NOT IN ('object', 'array', 'null')
          )
        )
        OR EXISTS (
          SELECT 1
          FROM article_brief_case_study_upload u
          WHERE u.article_brief_id = b.id
        )
      );
  ELSE
    UPDATE article_brief b
    SET case_study_required = TRUE
    WHERE case_study_required = FALSE
      AND (
        b.case_study_form_id IS NOT NULL
        OR b.case_study_submission_id IS NOT NULL
        OR (b.case_study_content IS NOT NULL AND b.case_study_content <> '')
        OR (
          b.case_study_images IS NOT NULL
          AND jsonb_typeof(b.case_study_images) = 'array'
          AND jsonb_array_length(b.case_study_images) > 0
        )
        OR (
          b.case_study_permissions IS NOT NULL
          AND (
            (jsonb_typeof(b.case_study_permissions) = 'object'
              AND (SELECT count(*) FROM jsonb_object_keys(b.case_study_permissions)) > 0)
            OR (jsonb_typeof(b.case_study_permissions) = 'array'
              AND jsonb_array_length(b.case_study_permissions) > 0)
            OR jsonb_typeof(b.case_study_permissions) NOT IN ('object', 'array', 'null')
          )
        )
      );
  END IF;
END$$;
