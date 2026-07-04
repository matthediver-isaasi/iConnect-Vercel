-- Task #2258: Inbox delivery for transactional emails — foundation
--
-- Adds member_transactional_message: one row per transactional email
-- (event confirmations, PO chasers, membership invoices, etc.) delivered to a
-- specific member, so it can appear in the member-facing /inbox alongside
-- campaign messages.
--
-- Unlike campaign messages (one email_campaign -> many recipients, with
-- per-(member, recipient) state held separately in member_inbox_message_state),
-- a transactional message row is inherently per-member: exactly one row per
-- delivered email to one member. The per-member read/pin/archive/favourite/
-- folder state is therefore co-located on this table rather than in a parallel
-- state table. folder_id reuses member_inbox_folder.
--
-- label_key is a stable built-in fallback key (events/membership/billing/forms/
-- groups/automations); communication_category_id, when set, points at a tenant
-- Communication Category whose name is preferred as the display label. Labels
-- are resolved at read time so renaming a category is reflected retroactively.
--
-- Idempotent: safe to run multiple times.

CREATE TABLE IF NOT EXISTS member_transactional_message (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  member_id UUID NOT NULL,
  recipient_email TEXT,
  subject TEXT NOT NULL DEFAULT '',
  preheader TEXT,
  body_html TEXT,
  from_name TEXT,
  from_email TEXT,
  communication_category_id UUID,
  label_key TEXT,
  sent_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  is_read BOOLEAN NOT NULL DEFAULT false,
  is_pinned BOOLEAN NOT NULL DEFAULT false,
  is_archived BOOLEAN NOT NULL DEFAULT false,
  is_favourite BOOLEAN NOT NULL DEFAULT false,
  folder_id UUID REFERENCES member_inbox_folder(id) ON DELETE SET NULL,
  read_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Primary access pattern: list a member's messages newest-first within a tenant.
CREATE INDEX IF NOT EXISTS idx_member_transactional_message_member
  ON member_transactional_message (tenant_id, member_id, sent_at DESC);

-- Unread badge count: count unread, non-archived rows per member.
CREATE INDEX IF NOT EXISTS idx_member_transactional_message_unread
  ON member_transactional_message (tenant_id, member_id)
  WHERE is_read = false AND is_archived = false;

CREATE INDEX IF NOT EXISTS idx_member_transactional_message_folder
  ON member_transactional_message (folder_id);

-- Ask PostgREST to reload its schema cache so the new table/columns are queryable.
NOTIFY pgrst, 'reload schema';
