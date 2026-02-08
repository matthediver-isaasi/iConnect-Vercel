import { databaseUrl } from '../_lib/database.js';
import { supabase } from '../_lib/database.js';
import { getTenantContext } from '../_lib/tenantContext.js';
import pg from 'pg';

const FORUM_SQL = `
CREATE TABLE IF NOT EXISTS forum_category (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id UUID NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  slug TEXT NOT NULL,
  display_order INTEGER DEFAULT 0,
  group_id UUID DEFAULT NULL,
  is_active BOOLEAN DEFAULT true,
  icon TEXT,
  header_image_url TEXT,
  header_image_focal_point JSONB DEFAULT '{"x": 50, "y": 50}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(tenant_id, slug)
);

-- Add header image columns if they don't exist (for existing installations)
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'forum_category' AND column_name = 'header_image_url') THEN
    ALTER TABLE forum_category ADD COLUMN header_image_url TEXT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'forum_category' AND column_name = 'header_image_focal_point') THEN
    ALTER TABLE forum_category ADD COLUMN header_image_focal_point JSONB DEFAULT '{"x": 50, "y": 50}';
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_forum_category_tenant ON forum_category(tenant_id);
CREATE INDEX IF NOT EXISTS idx_forum_category_group ON forum_category(group_id);

CREATE TABLE IF NOT EXISTS forum_thread (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id UUID NOT NULL,
  category_id UUID NOT NULL REFERENCES forum_category(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  slug TEXT NOT NULL,
  created_by UUID NOT NULL,
  created_by_type TEXT NOT NULL DEFAULT 'member' CHECK (created_by_type IN ('member', 'tenant_user')),
  is_pinned BOOLEAN DEFAULT false,
  is_locked BOOLEAN DEFAULT false,
  is_hidden BOOLEAN DEFAULT false,
  view_count INTEGER DEFAULT 0,
  post_count INTEGER DEFAULT 0,
  last_post_at TIMESTAMPTZ,
  last_post_by UUID,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_forum_thread_tenant ON forum_thread(tenant_id);
CREATE INDEX IF NOT EXISTS idx_forum_thread_category ON forum_thread(category_id);
CREATE INDEX IF NOT EXISTS idx_forum_thread_created_by ON forum_thread(created_by);
CREATE INDEX IF NOT EXISTS idx_forum_thread_pinned ON forum_thread(is_pinned);
CREATE INDEX IF NOT EXISTS idx_forum_thread_last_post ON forum_thread(last_post_at DESC);

CREATE TABLE IF NOT EXISTS forum_post (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id UUID NOT NULL,
  thread_id UUID NOT NULL REFERENCES forum_thread(id) ON DELETE CASCADE,
  parent_post_id UUID DEFAULT NULL,
  content TEXT NOT NULL,
  created_by UUID NOT NULL,
  created_by_type TEXT NOT NULL DEFAULT 'member' CHECK (created_by_type IN ('member', 'tenant_user')),
  is_hidden BOOLEAN DEFAULT false,
  is_deleted BOOLEAN DEFAULT false,
  is_edited BOOLEAN DEFAULT false,
  edited_at TIMESTAMPTZ,
  reaction_count INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Add is_deleted column if it doesn't exist (for existing installations)
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'forum_post' AND column_name = 'is_deleted') THEN
    ALTER TABLE forum_post ADD COLUMN is_deleted BOOLEAN DEFAULT false;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_forum_post_tenant ON forum_post(tenant_id);
CREATE INDEX IF NOT EXISTS idx_forum_post_thread ON forum_post(thread_id);
CREATE INDEX IF NOT EXISTS idx_forum_post_created_by ON forum_post(created_by);
CREATE INDEX IF NOT EXISTS idx_forum_post_parent ON forum_post(parent_post_id);

CREATE TABLE IF NOT EXISTS forum_reaction (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id UUID NOT NULL,
  post_id UUID NOT NULL REFERENCES forum_post(id) ON DELETE CASCADE,
  member_id UUID NOT NULL,
  reaction_type TEXT NOT NULL DEFAULT 'like',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(post_id, member_id, reaction_type)
);

CREATE INDEX IF NOT EXISTS idx_forum_reaction_post ON forum_reaction(post_id);
CREATE INDEX IF NOT EXISTS idx_forum_reaction_member ON forum_reaction(member_id);

CREATE TABLE IF NOT EXISTS forum_report (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id UUID NOT NULL,
  thread_id UUID,
  post_id UUID,
  reported_by UUID NOT NULL,
  reason TEXT NOT NULL,
  details TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'reviewed', 'resolved', 'dismissed')),
  resolved_by UUID,
  resolved_at TIMESTAMPTZ,
  resolution_note TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_forum_report_tenant ON forum_report(tenant_id);
CREATE INDEX IF NOT EXISTS idx_forum_report_status ON forum_report(status);
CREATE INDEX IF NOT EXISTS idx_forum_report_thread ON forum_report(thread_id);
CREATE INDEX IF NOT EXISTS idx_forum_report_post ON forum_report(post_id);

CREATE TABLE IF NOT EXISTS forum_moderation_log (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id UUID NOT NULL,
  action TEXT NOT NULL,
  target_type TEXT NOT NULL CHECK (target_type IN ('thread', 'post', 'category')),
  target_id UUID NOT NULL,
  performed_by UUID NOT NULL,
  details JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_forum_mod_log_tenant ON forum_moderation_log(tenant_id);
CREATE INDEX IF NOT EXISTS idx_forum_mod_log_target ON forum_moderation_log(target_type, target_id);
`;

export default async function handler(req, res) {
  if (req.method !== 'POST' && req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const tenantContext = await getTenantContext(req);
    if (!tenantContext?.tenantId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const connString = databaseUrl;
    if (!connString) {
      return res.status(500).json({ 
        error: 'DATABASE_URL not configured. Please run the SQL manually in Supabase SQL Editor.',
        sql: FORUM_SQL
      });
    }

    const client = new pg.Client({ connectionString: connString, ssl: { rejectUnauthorized: false } });
    await client.connect();

    try {
      await client.query(FORUM_SQL);
      await client.end();
    } catch (sqlErr) {
      await client.end();
      throw sqlErr;
    }

    if (supabase) {
      try {
        await supabase.rpc('exec_sql', { sql_text: "NOTIFY pgrst, 'reload schema';" });
      } catch (e) {
      }
    }

    return res.status(200).json({ success: true, message: 'Forum tables created successfully' });
  } catch (error) {
    console.error('[InitForumTables] Error:', error);
    return res.status(500).json({ error: error.message, sql: FORUM_SQL });
  }
}
