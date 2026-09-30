-- Support inbox item table
-- Stores per-recipient, per-event notification rows for support ticket activity.
-- Mirrors the article_brief_inbox_item pattern.

CREATE TABLE IF NOT EXISTS support_inbox_item (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid        NOT NULL,
  ticket_id     uuid        NOT NULL,
  recipient_member_id uuid,           -- NULL if recipient is a non-member tenant admin (email-only)
  event_type    text        NOT NULL,  -- 'new_ticket' | 'user_reply' | 'admin_reply'
  metadata      jsonb       NOT NULL DEFAULT '{}',
  read_at       timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS support_inbox_item_tenant_recipient_idx
  ON support_inbox_item (tenant_id, recipient_member_id);

CREATE INDEX IF NOT EXISTS support_inbox_item_ticket_idx
  ON support_inbox_item (ticket_id);

CREATE INDEX IF NOT EXISTS support_inbox_item_unread_idx
  ON support_inbox_item (tenant_id, recipient_member_id, read_at)
  WHERE read_at IS NULL;
