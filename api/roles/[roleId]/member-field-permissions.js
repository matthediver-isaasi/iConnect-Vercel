import { getSessionMember } from '../../_lib/session.js';
import { createClient } from '@supabase/supabase-js';
import { isResourceExcluded } from '../../_lib/roleVisibility.js';

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

  const { roleId } = req.query;

  if (!roleId) {
    return res.status(400).json({ error: 'Role ID is required' });
  }

  try {
    if (req.method === 'GET') {
      const { data: permissions, error } = await supabase
        .from('role_member_field_permission')
        .select('*')
        .eq('role_id', roleId);

      if (error) {
        console.error('[Get Role Member Permissions] Error:', error);
        return res.status(500).json({ error: error.message });
      }

      // Convert to a map for easier frontend usage
      const permissionMap = {};
      (permissions || []).forEach(p => {
        permissionMap[p.field_key] = p.permission;
      });

      return res.json(permissionMap);
    }

    if (req.method === 'PUT') {
      const permissions = Array.isArray(req.body) ? req.body : req.body?.permissions;

      console.log('[Update Role Member Permissions] Received permissions:', permissions);

      if (!Array.isArray(permissions)) {
        return res.status(400).json({ error: 'Permissions must be an array' });
      }

      const { error: deleteError } = await supabase
        .from('role_member_field_permission')
        .delete()
        .eq('role_id', roleId);

      if (deleteError) {
        console.error('[Update Role Member Permissions] Delete error:', deleteError);
        return res.status(500).json({ error: deleteError.message });
      }

      // Only insert non-default permissions (read_write is the default)
      const recordsToInsert = permissions
        .filter(p => p.permission !== 'read_write')
        .map(p => ({
          id: crypto.randomUUID(),
          role_id: roleId,
          field_key: p.field_key,
          permission: p.permission
        }));

      console.log('[Update Role Member Permissions] Inserting:', recordsToInsert);

      if (recordsToInsert.length > 0) {
        const { data: inserted, error: insertError } = await supabase
          .from('role_member_field_permission')
          .insert(recordsToInsert)
          .select();

        if (insertError) {
          console.error('[Update Role Member Permissions] Insert error:', insertError);
          return res.status(500).json({ error: insertError.message });
        }
        console.log('[Update Role Member Permissions] Inserted successfully:', inserted);
      }

      return res.json({ success: true, count: recordsToInsert.length });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (error) {
    console.error('[Role Member Permissions] Error:', error);
    return res.status(500).json({ error: 'Failed to process request' });
  }
}
