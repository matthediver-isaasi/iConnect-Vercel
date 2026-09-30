import { supabase } from '../_lib/database.js';
import { getSessionMember } from '../_lib/session.js';
import { getTenantContext } from '../_lib/tenantContext.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!supabase) {
    return res.status(503).json({ error: 'Database not configured' });
  }

  const member = await getSessionMember(req);
  if (!member) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  const tenantCtx = await getTenantContext(req);
  if (!tenantCtx.tenantId) {
    return res.status(403).json({ error: 'Tenant context required' });
  }

  try {
    const { roleIds } = req.query;

    if (!roleIds) {
      return res.json({ members: [] });
    }

    const roleIdArray = roleIds.split(',').filter(Boolean);
    if (roleIdArray.length === 0) {
      return res.json({ members: [] });
    }

    const { data: members, error } = await supabase
      .from('member')
      .select('id, first_name, last_name, email, role_id')
      .eq('tenant_id', tenantCtx.tenantId)
      .in('role_id', roleIdArray)
      .not('email', 'ilike', 'deleted_%@deleted.local')
      .order('first_name', { ascending: true });

    if (error) {
      console.error('[members-by-roles] Query error:', error);
      return res.status(500).json({ error: 'Failed to fetch members' });
    }

    return res.json({ members: members || [] });
  } catch (err) {
    console.error('[members-by-roles] Error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
