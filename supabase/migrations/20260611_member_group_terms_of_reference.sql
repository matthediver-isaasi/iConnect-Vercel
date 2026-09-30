-- Add a nullable terms-of-reference statement to member_group.
--
-- Optional multi-line text set by admins in the create/edit modal on the
-- Member Group Management page. When present, a member self-joining the group
-- on the Member Group Detail page must be shown these terms and explicitly
-- agree to them before the join completes. Idempotent.

ALTER TABLE member_group
  ADD COLUMN IF NOT EXISTS terms_of_reference TEXT;
