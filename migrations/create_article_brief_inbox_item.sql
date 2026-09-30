-- Article Brief Inbox Item: Tenant-scoped pseudo-inbox surfacing case-study
-- Permission/Copyright form submissions and document/image uploads against
-- existing briefs so editors can triage them from the Brief Management page
-- without opening every brief individually.
--
-- Read/archive state is shared at the tenant level for v1 (per-member state
-- can be added later if needed). The inbox archive flag is independent of the
-- brief lifecycle "archived" status.
--
-- The corresponding Drizzle schema entry lives in `shared/schema.ts` as
-- `articleBriefInboxItem` so `npm run db:push` will also create this table
-- in environments managed by Drizzle. This migration mirrors that definition
-- (including indexes) so environments using the SQL migration workflow stay
-- in sync.

CREATE TABLE IF NOT EXISTS article_brief_inbox_item (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  article_brief_id UUID NOT NULL REFERENCES article_brief(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL CHECK (event_type IN ('permission_submitted', 'copyright_submitted', 'files_uploaded')),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  read_at TIMESTAMPTZ,
  archived_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Tenant-scoped lookups, ordered by recency (used for inbox/archive listings)
CREATE INDEX IF NOT EXISTS idx_article_brief_inbox_item_tenant_created
  ON article_brief_inbox_item(tenant_id, created_at DESC);

-- Per-brief lookups (used when displaying or cleaning up items for a brief)
CREATE INDEX IF NOT EXISTS idx_article_brief_inbox_item_brief
  ON article_brief_inbox_item(article_brief_id);

-- Fast unread-count query: only unread, non-archived items per tenant.
-- Backs the badge on the Brief Management header.
CREATE INDEX IF NOT EXISTS idx_article_brief_inbox_item_unread
  ON article_brief_inbox_item(tenant_id, created_at DESC)
  WHERE read_at IS NULL AND archived_at IS NULL;
