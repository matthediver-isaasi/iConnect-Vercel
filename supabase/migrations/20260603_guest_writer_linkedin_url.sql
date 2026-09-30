-- Add a nullable LinkedIn profile URL to guest_writer.
--
-- Optional field set by admins on /GuestWriterManagement; when present it is
-- rendered as a LinkedIn link on the "About the author" card of a blog
-- article written by that guest writer. Idempotent.

ALTER TABLE guest_writer
  ADD COLUMN IF NOT EXISTS linkedin_url TEXT;
