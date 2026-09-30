import { getTenantContext, hasAdminAccess } from '../_lib/tenantContext.js';
import { supabase } from '../_lib/database.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const tenantContext = await getTenantContext(req);
  if (!tenantContext.isAuthenticated || !tenantContext.tenantId) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const isAdmin = await hasAdminAccess(tenantContext);
  if (!isAdmin) {
    return res.status(403).json({ error: 'Admin access required' });
  }

  const { tenantId } = tenantContext;
  const { q: query, limit = 10 } = req.query;

  if (!query || query.length < 2) {
    return res.json([]);
  }

  try {
    const searchPattern = `%${query}%`;

    const { data, error } = await supabase
      .from('external_writer')
      .select('id, first_name, last_name, email, organisation, job_title')
      .eq('tenant_id', tenantId)
      .or(`first_name.ilike.${searchPattern},last_name.ilike.${searchPattern},email.ilike.${searchPattern},organisation.ilike.${searchPattern}`)
      .limit(parseInt(limit, 10));

    if (error) {
      console.error('[External Writer Search] Error:', error);
      return res.status(500).json({ error: 'Failed to search external writers' });
    }

    return res.json(data || []);
  } catch (err) {
    console.error('[External Writer Search] Error:', err);
    return res.status(500).json({ error: 'Failed to search external writers' });
  }
}
