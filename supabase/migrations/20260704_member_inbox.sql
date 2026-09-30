-- Task #2203: Member Inbox
--
-- Adds two tables backing the member-facing Inbox page:
--   member_inbox_folder         - member-created folders for filing messages.
--   member_inbox_message_state  - per-member state for a delivered campaign
--                                 message, keyed by (member_id, recipient_id)
--                                 where recipient_id references
--                                 email_campaign_recipient.id. A missing row
--                                 means unread / unpinned / unarchived / no
--                                 folder. No hard FK to the recipient row so
--                                 campaign / event purges never break state.
--
-- Idempotent: safe to run multiple times.

CREATE TABLE IF NOT EXISTS member_inbox_folder (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  member_id UUID NOT NULL,
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_member_inbox_folder_member
  ON member_inbox_folder (tenant_id, member_id);

CREATE TABLE IF NOT EXISTS member_inbox_message_state (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  member_id UUID NOT NULL,
  recipient_id UUID NOT NULL,
  is_read BOOLEAN NOT NULL DEFAULT false,
  is_pinned BOOLEAN NOT NULL DEFAULT false,
  is_archived BOOLEAN NOT NULL DEFAULT false,
  folder_id UUID REFERENCES member_inbox_folder(id) ON DELETE SET NULL,
  read_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_member_inbox_state_member_recipient
  ON member_inbox_message_state (member_id, recipient_id);

CREATE INDEX IF NOT EXISTS idx_member_inbox_state_member
  ON member_inbox_message_state (tenant_id, member_id);

CREATE INDEX IF NOT EXISTS idx_member_inbox_state_folder
  ON member_inbox_message_state (folder_id);

-- Ask PostgREST to reload its schema cache so the new tables/columns are queryable.
NOTIFY pgrst, 'reload schema';
