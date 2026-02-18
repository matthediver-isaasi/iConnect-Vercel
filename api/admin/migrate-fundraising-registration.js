import { supabase } from '../_lib/database.js';
import { getTenantContext } from '../_lib/tenantContext.js';

export default async function handler(req, res) {
  if (!supabase) {
    return res.status(500).json({ error: 'Database not configured' });
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const tenantContext = await getTenantContext(req);
    if (!tenantContext?.tenantId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const columns = [
      { name: 'campaign_type', sql: "ALTER TABLE fundraising_campaign ADD COLUMN IF NOT EXISTS campaign_type TEXT NOT NULL DEFAULT 'individual'" },
      { name: 'max_team_size', sql: "ALTER TABLE fundraising_campaign ADD COLUMN IF NOT EXISTS max_team_size INTEGER DEFAULT 5" },
      { name: 'registration_open', sql: "ALTER TABLE fundraising_campaign ADD COLUMN IF NOT EXISTS registration_open BOOLEAN DEFAULT false" },
      { name: 'registration_message', sql: "ALTER TABLE fundraising_campaign ADD COLUMN IF NOT EXISTS registration_message TEXT" },
      { name: 'public_description', sql: "ALTER TABLE fundraising_campaign ADD COLUMN IF NOT EXISTS public_description TEXT" },
    ];

    const results = [];

    for (const col of columns) {
      const { error } = await supabase.rpc('exec_sql', { sql_text: col.sql });
      if (error) {
        if (error.message?.includes('does not exist')) {
          results.push({ column: col.name, status: 'skipped_no_rpc', message: error.message });
        } else {
          results.push({ column: col.name, status: 'error', message: error.message });
        }
      } else {
        results.push({ column: col.name, status: 'success' });
      }
    }

    const hasRpcError = results.some(r => r.status === 'skipped_no_rpc');
    if (hasRpcError) {
      return res.json({
        success: false,
        message: 'exec_sql RPC not available. Please run these SQL statements manually in the Supabase SQL editor:',
        sql: columns.map(c => c.sql + ';').join('\n'),
        results
      });
    }

    return res.json({ success: true, results });
  } catch (error) {
    console.error('[Migrate Fundraising Registration] Error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
