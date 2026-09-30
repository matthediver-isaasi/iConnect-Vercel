-- Add due_diligence_required column to form table
-- This column indicates whether a form requires due diligence review for submissions

ALTER TABLE form 
ADD COLUMN IF NOT EXISTS due_diligence_required BOOLEAN DEFAULT FALSE;

-- Add index for faster filtering of DD-enabled forms
CREATE INDEX IF NOT EXISTS idx_form_due_diligence_required ON form(due_diligence_required) WHERE due_diligence_required = TRUE;

-- Comment for documentation
COMMENT ON COLUMN form.due_diligence_required IS 'When true, submissions to this form require due diligence review process';
