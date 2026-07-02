-- Add organisation_award_id column to award_sublevel table
-- This allows sublevels to be associated with organisation awards

ALTER TABLE award_sublevel 
ADD COLUMN IF NOT EXISTS organisation_award_id UUID REFERENCES organisation_award(id) ON DELETE CASCADE;

-- Create index for faster lookups
CREATE INDEX IF NOT EXISTS idx_award_sublevel_organisation_award_id 
ON award_sublevel(organisation_award_id);
