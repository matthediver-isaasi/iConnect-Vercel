-- Add role-based visibility for organisation fields on My Organisation page
-- Mirrors the existing my_preferences_role_ids column for member fields
ALTER TABLE preference_field
ADD COLUMN IF NOT EXISTS my_organisation_role_ids JSONB DEFAULT NULL;

COMMENT ON COLUMN preference_field.my_organisation_role_ids IS 'Array of role UUIDs that can see this field on My Organisation page. NULL or empty = visible to all roles.';
