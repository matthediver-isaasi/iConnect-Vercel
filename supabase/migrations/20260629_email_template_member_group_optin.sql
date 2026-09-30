-- Add member-group opt-in controls to email_template.
--
-- `member_group_opt_in` (boolean, default false): when false the template is
--   hidden from all member-group campaign composers regardless of other settings.
--   Authors must explicitly opt each template in. Existing rows keep the
--   default (false) so nothing changes for currently published templates.
--
-- `member_group_classification_ids` (text[], default '{}'): when opt-in is true
--   and this array is EMPTY  => the template is available to ALL classifications
--   (and to groups with no classification).
--   When opt-in is true and this array is NON-EMPTY => the template is available
--   only to groups whose classification_id appears in the array. A group with no
--   classification_id never matches a non-empty allowlist.
--
-- Idempotent.

ALTER TABLE email_template
  ADD COLUMN IF NOT EXISTS member_group_opt_in BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE email_template
  ADD COLUMN IF NOT EXISTS member_group_classification_ids TEXT[] NOT NULL DEFAULT '{}';
