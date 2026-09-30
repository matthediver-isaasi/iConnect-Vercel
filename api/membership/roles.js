import { supabase } from '../_lib/database.js';
import { getTenantContext } from '../_lib/tenantContext.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const context = await getTenantContext(req);
  if (!context?.isAuthenticated) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  const tenantId = context.tenantId;
  if (!tenantId) {
    return res.status(400).json({ error: 'Tenant context not available' });
  }

  try {
    const organizationId = req.query.organizationId || req.query.organization_id;

    if (organizationId) {
      const { data: members, error: membersError } = await supabase
        .from('member')
        .select('role_id')
        .eq('tenant_id', tenantId)
        .eq('organization_id', organizationId)
        .not('role_id', 'is', null);

      if (membersError) {
        throw new Error(membersError.message);
      }

      const roleIds = Array.from(new Set((members || []).map(m => m.role_id).filter(Boolean)));

      if (roleIds.length === 0) {
        return res.json({ data: [] });
      }

      const { data, error } = await supabase
        .from('role')
        .select('id, name, is_tenant_admin')
        .eq('tenant_id', tenantId)
        .in('id', roleIds)
        .order('name', { ascending: true });

      if (error) {
        throw new Error(error.message);
      }

      return res.json({ data: data || [] });
    }

    const { data, error } = await supabase
      .from('role')
      .select('id, name, is_tenant_admin')
      .eq('tenant_id', tenantId)
      .order('name', { ascending: true });

    if (error) {
      throw new Error(error.message);
    }

    return res.json({ data: data || [] });
  } catch (error) {
    console.error('[Membership Roles] Error:', error);
    return res.status(500).json({ error: error.message || 'Failed to fetch roles' });
  }
}
