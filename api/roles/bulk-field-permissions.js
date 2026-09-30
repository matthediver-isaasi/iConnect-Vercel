import { getSessionMember } from '../_lib/session.js';
import { createClient } from '@supabase/supabase-js';
import { isResourceExcluded } from '../_lib/roleVisibility.js';

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY;
const supabase = supabaseUrl && supabaseServiceKey 
  ? createClient(supabaseUrl, supabaseServiceKey)
  : null;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, PUT, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (!supabase) {
    return res.status(503).json({ error: 'Database not configured' });
  }

  const sessionMember = await getSessionMember(req);
  if (!sessionMember) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  const { data: memberRole, error: roleError } = await supabase
    .from('role')
    .select('excluded_features')
    .eq('id', sessionMember.role_id)
    .single();

  const excludedFeatures = memberRole?.excluded_features || [];
  const isAdmin = !isResourceExcluded(excludedFeatures, 'admin.role-management');

  if (roleError || !isAdmin) {
    return res.status(403).json({ error: 'Admin access required' });
  }

  const tenantId = sessionMember.tenant_id;
  if (!tenantId) {
    return res.status(400).json({ error: 'Tenant context required' });
  }

  const { data: tenantRoles, error: tenantRolesError } = await supabase
    .from('role')
    .select('id')
    .eq('tenant_id', tenantId);

  if (tenantRolesError) {
    return res.status(500).json({ error: 'Failed to load tenant roles' });
  }

  const tenantRoleIds = new Set((tenantRoles || []).map(r => r.id));

  const { type } = req.query;
  const table = type === 'organization'
    ? 'role_organization_field_permission'
    : 'role_member_field_permission';

  try {
    if (req.method === 'GET') {
      const { data: permissions, error } = await supabase
        .from(table)
        .select('role_id, field_key, permission')
        .in('role_id', Array.from(tenantRoleIds));

      if (error) {
        console.error('[Bulk Permissions GET] Error:', error);
        return res.status(500).json({ error: error.message });
      }

      const result = {};
      (permissions || []).forEach(p => {
        if (!result[p.role_id]) result[p.role_id] = {};
        result[p.role_id][p.field_key] = p.permission;
      });

      return res.json(result);
    }

    if (req.method === 'PUT') {
      const { permissions } = req.body || {};

      if (!permissions || typeof permissions !== 'object') {
        return res.status(400).json({ error: 'permissions object is required: { roleId: { fieldKey: permission } }' });
      }

      const roleIds = Object.keys(permissions).filter(id => tenantRoleIds.has(id));
      if (roleIds.length === 0) {
        return res.json({ success: true, count: 0 });
      }

      const { error: deleteError } = await supabase
        .from(table)
        .delete()
        .in('role_id', roleIds);

      if (deleteError) {
        console.error('[Bulk Permissions PUT] Delete error:', deleteError);
        return res.status(500).json({ error: deleteError.message });
      }

      const records = [];
      for (const roleId of roleIds) {
        const fieldPerms = permissions[roleId];
        if (!fieldPerms || typeof fieldPerms !== 'object') continue;
        for (const [fieldKey, permission] of Object.entries(fieldPerms)) {
          if (permission !== 'read_write') {
            records.push({
              id: crypto.randomUUID(),
              role_id: roleId,
              field_key: fieldKey,
              permission
            });
          }
        }
      }

      if (records.length > 0) {
        const { error: insertError } = await supabase
          .from(table)
          .insert(records);

        if (insertError) {
          console.error('[Bulk Permissions PUT] Insert error:', insertError);
          return res.status(500).json({ error: insertError.message });
        }
      }

      return res.json({ success: true, count: records.length });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (error) {
    console.error('[Bulk Permissions] Error:', error);
    return res.status(500).json({ error: 'Failed to process request' });
  }
}
