import { getTenantContext } from '../_lib/tenantContext.js';
import { supabase } from '../_lib/database.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const tenantContext = await getTenantContext(req);
  if (!tenantContext.isAuthenticated || !tenantContext.tenantId) {
    return res.status(401).json({ error: 'Unauthorized - authentication and tenant context required' });
  }

  const { tenantId } = tenantContext;
  const { ids } = req.body;

  if (!Array.isArray(ids) || ids.length === 0) {
    return res.json([]);
  }

  const uniqueIds = [...new Set(ids)].slice(0, 200);

  try {
    const { data: members, error } = await supabase
      .from('member')
      .select('id, first_name, last_name, email')
      .eq('tenant_id', tenantId)
      .in('id', uniqueIds);

    if (error) {
      console.error('[Member By IDs] Error:', error);
      return res.status(500).json({ error: 'Failed to fetch members' });
    }

    return res.json(members || []);
  } catch (err) {
    console.error('[Member By IDs] Error:', err);
    return res.status(500).json({ error: 'Failed to fetch members' });
  }
}
