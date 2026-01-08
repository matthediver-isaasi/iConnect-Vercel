import { getSessionTenantUser } from '../_lib/session.js';
import { supabase } from '../_lib/database.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'GET') {
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
    const { data: tokens, error } = await supabase
      .from('xero_token')
      .select('id, tenant_id, tenant_name, expires_at, app_tenant_id')
      .eq('app_tenant_id', tenantUser.tenant_id);

    if (error) {
      console.error('[Admin] Xero status query error:', error);
      return res.json({ tokens: [] });
    }

    res.json({ tokens: tokens || [] });
  } catch (error) {
    console.error('[Admin] Xero status error:', error);
    res.status(500).json({ error: 'Failed to get Xero status' });
  }
}
