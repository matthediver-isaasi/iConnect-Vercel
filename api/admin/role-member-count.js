import { createClient } from '@supabase/supabase-js';
import { getSessionMember } from '../_lib/session.js';
import { isResourceExcluded } from '../_lib/roleVisibility.js';

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY;

const supabase = supabaseUrl && supabaseServiceKey 
  ? createClient(supabaseUrl, supabaseServiceKey)
  : null;

async function verifyPermission(req, permissionId) {
  const sessionMember = await getSessionMember(req);
  
  if (!sessionMember) {
    return { hasPermission: false, error: 'Not authenticated' };
  }

  if (!sessionMember.role_id) {
    return { hasPermission: false, memberId: sessionMember.id };
  }

  if (!supabase) {
    return { hasPermission: false, error: 'Database not configured' };
  }

  try {
    const { data: role, error: roleError } = await supabase
      .from('role')
      .select('excluded_features')
      .eq('id', sessionMember.role_id)
      .single();

    if (roleError || !role) {
      return { hasPermission: false, memberId: sessionMember.id };
    }

    const excludedFeatures = role.excluded_features || [];
    
    // Derive admin status from whether admin.role-management is NOT excluded
    const isAdmin = !isResourceExcluded(excludedFeatures, 'admin.role-management');
    if (isAdmin) {
      return { hasPermission: true, memberId: sessionMember.id };
    }

    const hasPermission = !isResourceExcluded(excludedFeatures, permissionId);

    return { hasPermission, memberId: sessionMember.id };
  } catch (error) {
    console.error('[Permission Verify] Error:', error);
    return { hasPermission: false, error: 'Verification failed' };
  }
}

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
    return res.status(503).json({ error: 'Supabase not configured' });
  }

  // Verify permission for communication.workflows
  const { hasPermission, error } = await verifyPermission(req, 'communication.workflows');

  if (error) {
    return res.status(401).json({ error });
  }

  if (!hasPermission) {
    return res.status(403).json({ error: 'Workflow management access required' });
  }

  try {
    const { roleId } = req.query;

    if (!roleId) {
      return res.status(400).json({ error: 'roleId is required' });
    }

    // Count all active members with this role (across all organizations)
    const { data: members, error: fetchError } = await supabase
      .from('member')
      .select('id, email, first_name, last_name')
      .eq('role_id', roleId)
      .eq('is_active', true)
      .not('email', 'is', null);

    if (fetchError) {
      console.error('[RoleMemberCount] Error:', fetchError);
      return res.status(500).json({ error: 'Failed to fetch member count' });
    }

    const membersWithEmail = (members || []).filter(m => m.email && m.email.trim() !== '');

    return res.json({
      count: membersWithEmail.length,
      roleId,
      members: membersWithEmail.map(m => ({
        id: m.id,
        email: m.email,
        name: [m.first_name, m.last_name].filter(Boolean).join(' ') || m.email
      }))
    });
  } catch (error) {
    console.error('[RoleMemberCount] Error:', error);
    return res.status(500).json({ error: 'Failed to fetch member count' });
  }
}
