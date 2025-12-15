import { getSessionMember } from '../../_lib/session.js';
import { createClient } from '@supabase/supabase-js';

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
    .select('is_admin')
    .eq('id', sessionMember.role_id)
    .single();

  if (roleError || !memberRole?.is_admin) {
    return res.status(403).json({ error: 'Admin access required' });
  }

  const { roleId } = req.query;

  if (!roleId) {
    return res.status(400).json({ error: 'Role ID is required' });
  }

  try {
    if (req.method === 'GET') {
      const { data: permissions, error } = await supabase
        .from('role_organization_field_permission')
        .select('*')
        .eq('role_id', roleId);

      if (error) {
        console.error('[Get Role Org Permissions] Error:', error);
        return res.status(500).json({ error: error.message });
      }

      return res.json(permissions || []);
    }

    if (req.method === 'PUT') {
      const { permissions } = req.body;

      if (!Array.isArray(permissions)) {
        return res.status(400).json({ error: 'Permissions must be an array' });
      }

      const { error: deleteError } = await supabase
        .from('role_organization_field_permission')
        .delete()
        .eq('role_id', roleId);

      if (deleteError) {
        console.error('[Update Role Org Permissions] Delete error:', deleteError);
        return res.status(500).json({ error: deleteError.message });
      }

      if (permissions.length > 0) {
        const recordsToInsert = permissions.map(p => ({
          id: crypto.randomUUID(),
          role_id: roleId,
          field_key: p.field_key,
          permission: p.permission
        }));

        const { error: insertError } = await supabase
          .from('role_organization_field_permission')
          .insert(recordsToInsert);

        if (insertError) {
          console.error('[Update Role Org Permissions] Insert error:', insertError);
          return res.status(500).json({ error: insertError.message });
        }
      }

      return res.json({ success: true });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (error) {
    console.error('[Role Org Permissions] Error:', error);
    return res.status(500).json({ error: 'Failed to process request' });
  }
}
