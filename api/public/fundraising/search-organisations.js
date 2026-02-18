import { createClient } from '@supabase/supabase-js';
import { resolveTenantFromRequest } from '../../_lib/tenantResolver.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY;

  if (!supabaseUrl || !supabaseServiceKey) {
    return res.status(503).json({ error: 'Database not configured' });
  }

  const supabase = createClient(supabaseUrl, supabaseServiceKey);

  try {
    const tenant = await resolveTenantFromRequest(req);
    if (!tenant?.id) {
      return res.status(404).json({ error: 'Tenant not found' });
    }

    const { q } = req.query;
    if (!q || q.trim().length < 2) {
      return res.json([]);
    }

    const searchTerm = q.trim();

    const { data: organisations, error } = await supabase
      .from('organisation')
      .select('id, name, city')
      .eq('tenant_id', tenant.id)
      .ilike('name', `%${searchTerm}%`)
      .order('name')
      .limit(8);

    if (error) {
      console.error('[Public Org Search] Error:', error);
      return res.status(500).json({ error: 'Search failed' });
    }

    return res.json(organisations || []);
  } catch (error) {
    console.error('[Public Org Search] Error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
