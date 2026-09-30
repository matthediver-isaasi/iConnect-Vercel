-- Add enforce_stage_sequence column to form_due_diligence_config
ALTER TABLE form_due_diligence_config 
ADD COLUMN IF NOT EXISTS enforce_stage_sequence boolean DEFAULT false;
