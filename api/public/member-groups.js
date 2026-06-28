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

    const { data: groups, error } = await supabase
      .from('member_group')
      .select(`
        id,
        name,
        description,
        header_image_url,
        allow_self_join,
        is_active,
        default_self_join_role
      `)
      .eq('tenant_id', tenant.id)
      .eq('allow_self_join', true)
      .neq('is_active', false)
      .order('name', { ascending: true });

    if (error) {
      console.error('[Public MemberGroups] Query error:', error);
      return res.status(500).json({ error: 'Failed to fetch member groups' });
    }

    res.json(groups || []);
  } catch (error) {
    console.error('[Public MemberGroups] Error:', error);
    res.status(500).json({ error: 'Failed to fetch member groups' });
  }
}
