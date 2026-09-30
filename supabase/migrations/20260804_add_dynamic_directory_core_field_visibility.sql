-- Per-directory core-field visibility overrides for dynamic directories.
-- JSONB map: core field key -> { front?: boolean, back?: boolean }.
-- Absent key or absent side = inherit the tenant-global Member Directory
-- Settings default (member) / org directory settings (organisation).
-- NULL = no overrides at all.

ALTER TABLE dynamic_directory
ADD COLUMN IF NOT EXISTS core_field_visibility JSONB DEFAULT NULL;

COMMENT ON COLUMN dynamic_directory.core_field_visibility IS
  'Per-directory core field visibility overrides: { "<core key>": { "front": bool, "back": bool } }. Missing key/side inherits the tenant-global directory display settings. NULL = inherit everything.';
