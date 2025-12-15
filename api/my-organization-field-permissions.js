import { getSessionMember } from './_lib/session.js';
import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY;
const supabase = supabaseUrl && supabaseServiceKey 
  ? createClient(supabaseUrl, supabaseServiceKey)
  : null;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!supabase) {
    return res.status(503).json({ error: 'Database not configured' });
  }

  const sessionMember = await getSessionMember(req);
  
  if (!sessionMember) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  try {
    const roleId = sessionMember.role_id;
    
    if (!roleId) {
      return res.json({});
    }

    const { data: permissions, error } = await supabase
      .from('role_organization_field_permission')
      .select('field_key, permission')
      .eq('role_id', roleId);

    if (error) {
      console.error('[My Organization Field Permissions] Error:', error);
      return res.json({});
    }

    const permissionMap = {};
    if (permissions) {
      permissions.forEach(p => {
        permissionMap[p.field_key] = p.permission;
      });
    }

    return res.json(permissionMap);
  } catch (error) {
    console.error('[My Organization Field Permissions] Error:', error);
    return res.status(500).json({ error: 'Failed to get permissions' });
  }
}
