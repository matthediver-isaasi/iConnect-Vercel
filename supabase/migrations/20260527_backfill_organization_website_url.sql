-- Backfill organization.website_url from organization.website
--
-- Background: The organization table has two website columns. `website_url` is the
-- canonical column used by every read/write path in the app (org list, org detail,
-- FormBuilder, Zoho sync, replay scripts). A second `website` column was added by
-- scripts/add-org-email-address-fields.sql but never adopted elsewhere — and the DD
-- stage-action field-mapping executor was the only writer to it. Any organisation
-- that received a value via a DD "Website" mapping has the value in `website` but
-- not in `website_url`, so it didn't show up anywhere in the UI.
--
-- This migration copies `website` into `website_url` for rows where `website_url`
-- is null or empty and `website` has a value. Rows whose `website_url` is already
-- populated are left untouched.
--
-- Idempotent: re-running performs no further writes.

UPDATE organization
SET website_url = website
WHERE (website_url IS NULL OR website_url = '')
  AND website IS NOT NULL
  AND website <> '';
