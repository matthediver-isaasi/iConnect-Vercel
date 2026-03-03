import { createClient } from '@supabase/supabase-js';
import { resolveTenantFromRequest } from '../_lib/tenantResolver.js';

export default async function handler(req, res) {
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
      .from('communication_category')
      .select('id, name, description')
      .eq('is_active', true)
      .eq('tenant_id', tenant.id)
      .order('display_order', { ascending: true });

    if (error) {
      console.error('Error fetching communication categories:', error);
      return res.status(500).json({ error: error.message });
    }

    const categories = data || [];

    const { data: roleAssignments, error: roleError } = await supabase
      .from('communication_category_role')
      .select('category_id, role_id')
      .eq('tenant_id', tenant.id);

    if (roleError) {
      console.error('Error fetching category role assignments:', roleError);
    }

    const roleMap = {};
    (roleAssignments || []).forEach(r => {
      if (!roleMap[r.category_id]) roleMap[r.category_id] = [];
      roleMap[r.category_id].push(r.role_id);
    });

    const enriched = categories.map(cat => ({
      ...cat,
      role_ids: roleMap[cat.id] || [],
    }));

    return res.json(enriched);
  } catch (error) {
    console.error('Public communication categories fetch error:', error);
    return res.status(500).json({ error: 'Failed to fetch communication categories' });
  }
}
