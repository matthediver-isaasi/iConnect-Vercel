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

    const { data, error } = await supabase
      .from('resource_category')
      .select('id, name, description, subcategories, applies_to_content_types, display_order, is_active')
      .eq('tenant_id', tenant.id)
      .or('is_active.eq.true,is_active.is.null')
      .order('display_order', { ascending: true });

    if (error) {
      console.error('Error fetching resource categories:', error);
      return res.status(500).json({ error: error.message });
    }

    return res.json(data || []);
  } catch (error) {
    console.error('Public resource categories fetch error:', error);
    return res.status(500).json({ error: 'Failed to fetch resource categories' });
  }
}
