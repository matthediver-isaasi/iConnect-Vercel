-- Add optional Copyright Assignment form workflow columns to article_brief table
-- The existing case_study_form_* columns continue to act as the Permission slot.
ALTER TABLE article_brief ADD COLUMN IF NOT EXISTS case_study_copyright_form_id UUID REFERENCES form(id);
ALTER TABLE article_brief ADD COLUMN IF NOT EXISTS case_study_copyright_form_sent_at TIMESTAMPTZ;
ALTER TABLE article_brief ADD COLUMN IF NOT EXISTS case_study_copyright_submission_id UUID REFERENCES form_submission(id);
