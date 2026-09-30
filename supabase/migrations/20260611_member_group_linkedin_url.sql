-- Add a nullable LinkedIn profile URL to member_group.
--
-- Optional field set by admins in the create/edit modal on the Member Group
-- Management page; when present it is rendered as a LinkedIn link on the
-- Member Group Detail page header. Idempotent.

ALTER TABLE member_group
  ADD COLUMN IF NOT EXISTS linkedin_url TEXT;
