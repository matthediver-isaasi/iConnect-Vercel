-- Add show_members_on_card_back column to dynamic_directory table
-- Controls whether the members/contacts list appears on the back of the
-- organisation directory card. Defaults to true to preserve existing behaviour.

ALTER TABLE dynamic_directory
ADD COLUMN IF NOT EXISTS show_members_on_card_back boolean NOT NULL DEFAULT true;

COMMENT ON COLUMN dynamic_directory.show_members_on_card_back IS
  'When true (default), organisation cards in this directory show the contacts-by-role list (and member count) on the back of the card. When false, the members section is hidden and the reverse-card dialog is suppressed entirely if no other content is available.';
