import { getEmailStats, getEmailEvents } from '../_lib/emailLogsService.js';
import { supabase } from '../_lib/database.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const session = req.session;
    
    if (!session || !session.tenantUserId || !session.tenantId) {
      return res.status(401).json({ error: 'Unauthorized - tenant session required' });
    }

    const tenantId = session.tenantId;
    const { type, limit, page, event, recipient } = req.query;

    console.log(`[Email Logs API] Request type: ${type || 'summary'} for tenant: ${tenantId}`);

    if (type === 'events') {
      const result = await getEmailEvents(tenantId, {
        limit: parseInt(limit) || 25,
        page: page || null,
        event: event || null,
        recipient: recipient || null
      });

      return res.json(result);
    }

    const result = await getEmailStats(tenantId);
    return res.json(result);

  } catch (error) {
    console.error('[Email Logs API] Error:', error);
    return res.status(500).json({ 
      error: 'Failed to fetch email logs',
      details: error.message 
    });
  }
}
