import { databaseUrl } from '../_lib/database.js';
import { supabase } from '../_lib/database.js';
import { getTenantContext } from '../_lib/tenantContext.js';
import pg from 'pg';

const RESOURCE_VIEW_SQL = `
CREATE TABLE IF NOT EXISTS resource_view (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  resource_id UUID NOT NULL,
  user_identifier TEXT NOT NULL,
  is_member BOOLEAN DEFAULT false,
  viewed_at TIMESTAMPTZ DEFAULT NOW(),
  tenant_id UUID NOT NULL,
  UNIQUE(resource_id, user_identifier)
);

CREATE INDEX IF NOT EXISTS idx_resource_view_resource ON resource_view(resource_id);
CREATE INDEX IF NOT EXISTS idx_resource_view_tenant ON resource_view(tenant_id);
CREATE INDEX IF NOT EXISTS idx_resource_view_viewed_at ON resource_view(viewed_at);
CREATE INDEX IF NOT EXISTS idx_resource_view_tenant_viewed_at ON resource_view(tenant_id, viewed_at);
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
        sql: RESOURCE_VIEW_SQL
      });
    }

    const client = new pg.Client({ connectionString: connString, ssl: { rejectUnauthorized: false } });
    await client.connect();

    try {
      await client.query(RESOURCE_VIEW_SQL);
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

    return res.status(200).json({ success: true, message: 'Resource view table created successfully' });
  } catch (error) {
    console.error('[InitResourceViewTable] Error:', error);
    return res.status(500).json({ error: error.message, sql: RESOURCE_VIEW_SQL });
  }
}
