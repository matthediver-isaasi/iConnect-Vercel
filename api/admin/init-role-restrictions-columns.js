import { databaseUrl } from '../_lib/database.js';
import { getTenantContext } from '../_lib/tenantContext.js';
import pg from 'pg';

const MIGRATION_SQL = `
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'organization' AND column_name = 'training_fund_allowed_role_ids') THEN
    ALTER TABLE organization ADD COLUMN training_fund_allowed_role_ids JSONB DEFAULT NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'organization' AND column_name = 'voucher_allowed_role_ids') THEN
    ALTER TABLE organization ADD COLUMN voucher_allowed_role_ids JSONB DEFAULT NULL;
  END IF;
END $$;
`;

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const tenantContext = await getTenantContext(req);
  if (!tenantContext || !tenantContext.isAuthenticated) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!databaseUrl) {
    return res.status(503).json({ error: 'Database not configured' });
  }

  const client = new pg.Client({ connectionString: databaseUrl, ssl: { rejectUnauthorized: false } });

  try {
    await client.connect();
    await client.query(MIGRATION_SQL);
    await client.end();

    return res.json({ success: true, message: 'Role restriction columns added to organization table successfully' });
  } catch (error) {
    console.error('[init-role-restrictions-columns] Error:', error);
    try { await client.end(); } catch (e) {}
    return res.status(500).json({ error: error.message });
  }
}
