import { getTenantContext } from '../_lib/tenantContext.js';
import { supabase } from '../_lib/database.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const tenantContext = await getTenantContext(req);
  if (!tenantContext.tenantId) {
    return res.status(401).json({ error: 'Unauthorized - tenant required' });
  }

  const { tenantId } = tenantContext;
  const { q: query, limit = 10 } = req.query;

  if (!query || query.length < 2) {
    return res.json([]);
  }

  try {
    // Search members by name or email using ilike for case-insensitive matching
    const searchPattern = `%${query}%`;
    
    const { data: members, error } = await supabase
      .from('member')
      .select('id, first_name, last_name, email')
      .eq('tenant_id', tenantId)
      .not('email', 'ilike', 'deleted_%@deleted.local')
      .or(`first_name.ilike.${searchPattern},last_name.ilike.${searchPattern},email.ilike.${searchPattern}`)
      .limit(parseInt(limit, 10));

    if (error) {
      console.error('[Member Search] Error:', error);
      return res.status(500).json({ error: 'Failed to search members' });
    }

    return res.json(members || []);
  } catch (err) {
    console.error('[Member Search] Error:', err);
    return res.status(500).json({ error: 'Failed to search members' });
  }
}
