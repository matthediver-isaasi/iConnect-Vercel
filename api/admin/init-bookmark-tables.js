import { databaseUrl } from '../_lib/database.js';
import { supabase } from '../_lib/database.js';
import { getTenantContext } from '../_lib/tenantContext.js';
import pg from 'pg';

const BOOKMARK_SQL = `
CREATE TABLE IF NOT EXISTS member_bookmark (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id UUID NOT NULL,
  member_id UUID NOT NULL,
  entity_type TEXT NOT NULL CHECK (entity_type IN ('blog_post', 'resource', 'news_post', 'event', 'forum_thread', 'form')),
  entity_id UUID NOT NULL,
  sort_order INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(tenant_id, member_id, entity_type, entity_id)
);

ALTER TABLE member_bookmark ADD COLUMN IF NOT EXISTS sort_order INTEGER DEFAULT 0;

ALTER TABLE member_bookmark DROP CONSTRAINT IF EXISTS member_bookmark_entity_type_check;
ALTER TABLE member_bookmark ADD CONSTRAINT member_bookmark_entity_type_check CHECK (entity_type IN ('blog_post', 'resource', 'news_post', 'event', 'forum_thread', 'form'));

CREATE INDEX IF NOT EXISTS idx_member_bookmark_tenant ON member_bookmark(tenant_id);
CREATE INDEX IF NOT EXISTS idx_member_bookmark_member ON member_bookmark(member_id);
CREATE INDEX IF NOT EXISTS idx_member_bookmark_entity ON member_bookmark(entity_type, entity_id);

CREATE TABLE IF NOT EXISTS member_bookmark_preferences (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id UUID NOT NULL,
  member_id UUID NOT NULL,
  category_order JSONB DEFAULT '["blog_post","news_post","event","resource","forum_thread"]'::jsonb,
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(tenant_id, member_id)
);

CREATE INDEX IF NOT EXISTS idx_member_bookmark_prefs_member ON member_bookmark_preferences(tenant_id, member_id);
`;

export default async function handler(req, res) {
  if (req.method !== 'POST') {
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
        error: 'DATABASE_URL not configured.',
        sql: BOOKMARK_SQL
      });
    }

    const client = new pg.Client({ connectionString: connString, ssl: { rejectUnauthorized: false } });
    await client.connect();

    try {
      await client.query(BOOKMARK_SQL);
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

    return res.status(200).json({ success: true, message: 'Bookmark tables created successfully' });
  } catch (error) {
    console.error('[InitBookmarkTables] Error:', error);
    return res.status(500).json({ error: error.message, sql: BOOKMARK_SQL });
  }
}
