-- Add case study external form workflow columns to article_brief table
ALTER TABLE article_brief ADD COLUMN IF NOT EXISTS case_study_form_id UUID REFERENCES form(id);
ALTER TABLE article_brief ADD COLUMN IF NOT EXISTS case_study_provider JSONB;
ALTER TABLE article_brief ADD COLUMN IF NOT EXISTS case_study_email_content TEXT;
ALTER TABLE article_brief ADD COLUMN IF NOT EXISTS case_study_form_sent_at TIMESTAMPTZ;
ALTER TABLE article_brief ADD COLUMN IF NOT EXISTS case_study_submission_id UUID REFERENCES form_submission(id);
