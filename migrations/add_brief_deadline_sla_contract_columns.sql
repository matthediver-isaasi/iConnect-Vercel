-- Add writer_deadline, editor_deadline, sla, and contract columns to article_brief
ALTER TABLE article_brief ADD COLUMN IF NOT EXISTS writer_deadline TIMESTAMPTZ;
ALTER TABLE article_brief ADD COLUMN IF NOT EXISTS editor_deadline TIMESTAMPTZ;
ALTER TABLE article_brief ADD COLUMN IF NOT EXISTS sla TEXT;
ALTER TABLE article_brief ADD COLUMN IF NOT EXISTS contract TEXT;
