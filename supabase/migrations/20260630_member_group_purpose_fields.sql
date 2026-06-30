-- Add "Who the group is for" and "About the group" optional rich-text fields to member_group
ALTER TABLE member_group ADD COLUMN IF NOT EXISTS who_is_it_for TEXT;
ALTER TABLE member_group ADD COLUMN IF NOT EXISTS about_the_group TEXT;
