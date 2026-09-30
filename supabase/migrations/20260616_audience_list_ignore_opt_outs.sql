-- Add a per-audience-list "ignore opt-outs" toggle.
--
-- When enabled, recipients resolved from this list deliberately bypass ALL
-- opt-out suppression (global opt-out flag, global unsubscribe list, category
-- subscription funnel, and category unsubscribe list). This is for
-- transactional / operationally-required messages (e.g. dietary-requirement
-- forms for a paid event) that fall outside marketing-consent rules.
--
-- Off by default so existing lists are unaffected. Idempotent: the column is
-- added only if it does not already exist.

ALTER TABLE audience_list
  ADD COLUMN IF NOT EXISTS ignore_opt_outs BOOLEAN NOT NULL DEFAULT false;
