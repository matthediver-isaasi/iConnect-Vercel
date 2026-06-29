-- Add self-join closed flag and custom closed-button label to member_group
ALTER TABLE member_group ADD COLUMN IF NOT EXISTS self_join_closed BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE member_group ADD COLUMN IF NOT EXISTS self_join_closed_label TEXT;
