import { createClient } from '@supabase/supabase-js';
import { resolveTenantFromRequest } from '../_lib/tenantResolver.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY;

  if (!supabaseUrl || !supabaseServiceKey) {
    return res.status(503).json({ error: 'Supabase not configured' });
  }

  const supabase = createClient(supabaseUrl, supabaseServiceKey);

  try {
    const tenant = await resolveTenantFromRequest(req);

    if (!tenant) {
      return res.status(404).json({ error: 'Tenant not found' });
    }

    const { data: roles, error } = await supabase
      .from('role')
      .select(`
        id,
        name,
        display_name
      `)
      .eq('tenant_id', tenant.id)
      .order('name', { ascending: true });

    if (error) {
      console.error('[Public Roles] Query error:', error);
      return res.status(500).json({ error: 'Failed to fetch roles' });
    }

    return res.status(200).json(roles || []);
  } catch (error) {
    console.error('[Public Roles] Error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
