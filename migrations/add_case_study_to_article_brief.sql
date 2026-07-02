-- Add case study columns to article_brief table
ALTER TABLE article_brief ADD COLUMN IF NOT EXISTS case_study_content TEXT;
ALTER TABLE article_brief ADD COLUMN IF NOT EXISTS case_study_images JSONB DEFAULT '[]'::jsonb;
ALTER TABLE article_brief ADD COLUMN IF NOT EXISTS case_study_permissions JSONB;
