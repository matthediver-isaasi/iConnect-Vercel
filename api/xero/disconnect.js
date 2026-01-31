import { getSessionTenantUser } from '../_lib/session.js';
import { supabase } from '../_lib/database.js';

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

  if (!supabase) {
    return res.status(503).json({ error: 'Database not configured' });
  }

  const tenantUser = await getSessionTenantUser(req);
  
  if (!tenantUser) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const { error } = await supabase
      .from('xero_token')
      .delete()
      .eq('app_tenant_id', tenantUser.tenant_id);

    if (error) {
      console.error('[Xero] Disconnect error:', error);
      return res.status(500).json({ error: 'Failed to disconnect Xero' });
    }

    console.log('[Xero] Disconnected for tenant:', tenantUser.tenant_id);
    res.json({ success: true });
  } catch (error) {
    console.error('[Xero] Disconnect error:', error);
    res.status(500).json({ error: 'Failed to disconnect Xero' });
  }
}
