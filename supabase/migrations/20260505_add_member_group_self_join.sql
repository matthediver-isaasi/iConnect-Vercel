-- Add self-join capability and header image to member_group
ALTER TABLE member_group ADD COLUMN IF NOT EXISTS header_image_url TEXT;
ALTER TABLE member_group ADD COLUMN IF NOT EXISTS allow_self_join BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE member_group ADD COLUMN IF NOT EXISTS default_self_join_role TEXT;
