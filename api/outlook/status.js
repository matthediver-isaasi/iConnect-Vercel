import { getSession } from '../_lib/session.js';
import { supabase } from '../_lib/database.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
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

    if (req.method === 'GET') {
      const { data: connection, error } = await supabase
        .from('outlook_connection')
        .select('id, microsoft_email, display_name, status, last_sync_at, sync_error, created_at')
        .eq('tenant_id', session.tenantId)
        .eq('identity_id', identityId)
        .single();

      if (error && error.code !== 'PGRST116') {
        console.error('[Outlook Status] Database error:', error);
        return res.status(500).json({ error: 'Failed to check connection status' });
      }

      if (!connection) {
        return res.status(200).json({ connected: false });
      }

      return res.status(200).json({
        connected: true,
        status: connection.status,
        email: connection.microsoft_email,
        displayName: connection.display_name,
        lastSyncAt: connection.last_sync_at,
        syncError: connection.sync_error,
        connectedAt: connection.created_at
      });
    }

    if (req.method === 'DELETE') {
      const { error } = await supabase
        .from('outlook_connection')
        .delete()
        .eq('tenant_id', session.tenantId)
        .eq('identity_id', identityId);

      if (error) {
        console.error('[Outlook Status] Failed to disconnect:', error);
        return res.status(500).json({ error: 'Failed to disconnect Outlook' });
      }

      console.log('[Outlook Status] Disconnected Outlook for identity:', identityId);
      return res.status(200).json({ success: true, message: 'Outlook disconnected' });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (error) {
    console.error('[Outlook Status] Error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
}
