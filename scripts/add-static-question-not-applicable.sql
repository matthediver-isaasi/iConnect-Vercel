-- Add static_question_not_applicable column to form_submission_due_diligence table
-- This stores which questions have been marked as "Not Applicable" for scoring purposes

ALTER TABLE form_submission_due_diligence
ADD COLUMN IF NOT EXISTS static_question_not_applicable JSONB DEFAULT '{}'::jsonb;

-- Comment explaining the column
COMMENT ON COLUMN form_submission_due_diligence.static_question_not_applicable IS 'Maps question IDs to boolean - true means the question is marked as Not Applicable and should be excluded from score calculations';
