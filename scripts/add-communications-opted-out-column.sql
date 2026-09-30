-- Add communications_opted_out_all column to member table
-- This is a master opt-out flag that overrides all individual communication preferences
-- When true, the member has opted out of ALL communications

ALTER TABLE member 
ADD COLUMN IF NOT EXISTS communications_opted_out_all BOOLEAN DEFAULT false;

COMMENT ON COLUMN member.communications_opted_out_all IS 'Master opt-out flag for all communications. When true, member is excluded from all communication lists regardless of individual preferences.';
