-- Split the legacy "Admin List" toggle on PreferenceField into two
-- independent flags per scope: one controls the admin CRM column picker,
-- the other controls the admin CRM sidebar filter list.
--
-- The legacy show_in_admin_list / show_in_member_admin_list columns are
-- kept and continue to be written (mirrored from the new flags) for
-- backward compatibility with any other readers.
--
-- All four new flags default to true so existing fields continue to be
-- visible in both the column picker and the filter sidebar until an
-- admin explicitly turns one of them off.

ALTER TABLE preference_field
  ADD COLUMN IF NOT EXISTS show_in_admin_column BOOLEAN DEFAULT true,
  ADD COLUMN IF NOT EXISTS show_in_admin_filter BOOLEAN DEFAULT true,
  ADD COLUMN IF NOT EXISTS show_in_member_admin_column BOOLEAN DEFAULT true,
  ADD COLUMN IF NOT EXISTS show_in_member_admin_filter BOOLEAN DEFAULT true;
