-- Member-facing group email campaigns (task-674)
-- Adds opt-in role list on member_group + ownership columns on email_campaign
-- so trusted group roles can author tenant-side email_campaign rows that
-- only target their own group.

ALTER TABLE member_group
  ADD COLUMN IF NOT EXISTS ems_enabled_roles TEXT[] NOT NULL DEFAULT '{}';

ALTER TABLE email_campaign
  ADD COLUMN IF NOT EXISTS created_by_member_id UUID REFERENCES member(id) ON DELETE SET NULL;

ALTER TABLE email_campaign
  ADD COLUMN IF NOT EXISTS member_group_id UUID REFERENCES member_group(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS email_campaign_member_owner_idx
  ON email_campaign (created_by_member_id, member_group_id);
