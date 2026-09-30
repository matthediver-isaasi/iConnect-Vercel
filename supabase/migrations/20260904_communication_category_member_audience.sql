-- Existing private categories remain members-only and existing public categories
-- remain available to both audiences. Administrators can explicitly disable the
-- member audience without changing public subscription access.
ALTER TABLE communication_category
  ADD COLUMN IF NOT EXISTS member_enabled BOOLEAN NOT NULL DEFAULT true;

UPDATE communication_category
SET member_enabled = true
WHERE member_enabled IS NULL;