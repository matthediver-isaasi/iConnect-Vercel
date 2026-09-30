import { createClient } from '@supabase/supabase-js';
import { resolveTenantFromRequest } from '../_lib/tenantResolver.js';

export function attachCommunicationCategoryRoleIds(categories, roleAssignments) {
  const roleIdsByCategory = new Map();
  for (const assignment of roleAssignments || []) {
    if (!assignment?.category_id || !assignment?.role_id) continue;
    const roleIds = roleIdsByCategory.get(assignment.category_id) || [];
    roleIds.push(assignment.role_id);
    roleIdsByCategory.set(assignment.category_id, roleIds);
  }
  return (categories || []).map(category => ({
    ...category,
    role_ids: roleIdsByCategory.get(category.id) || [],
  }));
}

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
      .select('id, name, description, is_public, member_enabled')
      .eq('is_active', true)
      .eq('is_public', true)
      .eq('tenant_id', tenant.id)
      .order('display_order', { ascending: true });

    if (error) {
      console.error('Error fetching communication categories:', error);
      return res.status(500).json({ error: error.message });
    }

    const categoryIds = (data || []).map(category => category.id);
    if (categoryIds.length === 0) return res.json([]);

    const { data: roleAssignments, error: roleError } = await supabase
      .from('communication_category_role')
      .select('category_id, role_id')
      .eq('tenant_id', tenant.id)
      .in('category_id', categoryIds);
    if (roleError) {
      console.error('Error fetching communication category roles:', roleError);
      return res.status(500).json({ error: roleError.message });
    }

    return res.json(attachCommunicationCategoryRoleIds(data, roleAssignments));
  } catch (error) {
    console.error('Public communication categories fetch error:', error);
    return res.status(500).json({ error: 'Failed to fetch communication categories' });
  }
}
