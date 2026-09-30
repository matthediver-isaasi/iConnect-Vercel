import { databaseUrl } from '../_lib/database.js';
import { getTenantContext } from '../_lib/tenantContext.js';
import pg from 'pg';

const MIGRATION_SQL = `
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'event_email' AND column_name = 'custom_unit') THEN
    ALTER TABLE event_email ADD COLUMN custom_unit VARCHAR(50);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'event_email' AND column_name = 'custom_send_at') THEN
    ALTER TABLE event_email ADD COLUMN custom_send_at TIMESTAMP WITH TIME ZONE;
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

    return res.json({ success: true, message: 'Event email custom_unit and custom_send_at columns added successfully' });
  } catch (error) {
    console.error('[init-event-email-custom-columns] Error:', error);
    try { await client.end(); } catch (e) {}
    return res.status(500).json({ error: error.message });
  }
}
