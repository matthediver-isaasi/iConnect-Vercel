import { getSession } from '../_lib/session.js';
import { supabase } from '../_lib/database.js';
import { syncEmailsForConnection } from '../_lib/outlookSync.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const sessionResult = await getSession(req);

    if (!sessionResult || !sessionResult.data) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const session = sessionResult.data;
    if (!session.tenantId) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const identityId = session.identityId || session.userId || session.memberId;
    if (!identityId) {
      return res.status(401).json({ error: 'Could not determine user identity' });
    }

    const { memberId } = req.body || {};

    const { data: connection, error: connError } = await supabase
      .from('outlook_connection')
      .select('*')
      .eq('tenant_id', session.tenantId)
      .eq('identity_id', identityId)
      .single();

    if (connError || !connection) {
      return res.status(400).json({ error: 'Outlook not connected' });
    }

    if (connection.status !== 'active') {
      return res.status(400).json({ error: 'Outlook connection is not active' });
    }

    const result = await syncEmailsForConnection(connection, session.tenantId, {
      memberId,
      identityId
    });

    console.log(`[Outlook Sync] Synced ${result.synced} emails, skipped ${result.agentOnlySkipped} agent-only emails for tenant ${session.tenantId}`);

    res.status(200).json({
      synced: result.synced,
      agentOnlySkipped: result.agentOnlySkipped,
      errors: result.errors.length > 0 ? result.errors : undefined,
      message: `Synced ${result.synced} emails${result.agentOnlySkipped > 0 ? ` (${result.agentOnlySkipped} internal emails excluded)` : ''}`
    });
  } catch (error) {
    console.error('[Outlook Sync] Error:', error);
    res.status(500).json({ error: 'Failed to sync emails' });
  }
}
