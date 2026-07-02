import { databaseUrl } from '../_lib/database.js';
import { getTenantContext } from '../_lib/tenantContext.js';
import pg from 'pg';

const MIGRATION_SQL = `
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'meeting_template' AND column_name = 'zoom_user_id') THEN
    ALTER TABLE meeting_template ADD COLUMN zoom_user_id TEXT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'meeting_template' AND column_name = 'zoom_user_email') THEN
    ALTER TABLE meeting_template ADD COLUMN zoom_user_email TEXT;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'agent_booking' AND column_name = 'zoom_meeting_id') THEN
    ALTER TABLE agent_booking ADD COLUMN zoom_meeting_id TEXT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'agent_booking' AND column_name = 'zoom_join_url') THEN
    ALTER TABLE agent_booking ADD COLUMN zoom_join_url TEXT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'agent_booking' AND column_name = 'zoom_start_url') THEN
    ALTER TABLE agent_booking ADD COLUMN zoom_start_url TEXT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'agent_booking' AND column_name = 'zoom_password') THEN
    ALTER TABLE agent_booking ADD COLUMN zoom_password TEXT;
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

    return res.json({ success: true, message: 'Zoom booking columns added successfully' });
  } catch (error) {
    console.error('[init-zoom-booking-columns] Error:', error);
    try { await client.end(); } catch (e) {}
    return res.status(500).json({ error: error.message });
  }
}
