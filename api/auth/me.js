import { getSessionMember } from '../_lib/session.js';
import { isResourceExcluded } from '../_lib/roleVisibility.js';
import { supabase } from '../_lib/database.js';

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

  try {
    const member = await getSessionMember(req);
    
    if (!member) {
      return res.status(200).json(null);
    }

    // Fetch role to determine permissions
    let isAdmin = false;
    let canEditMembers = false;
    let canManageCommunications = false;
    
    if (member.role_id && supabase) {
      const { data: role } = await supabase
        .from('role')
        .select('excluded_features')
        .eq('id', member.role_id)
        .single();
      
      const excludedFeatures = role?.excluded_features || [];
      
      // Derive admin status from whether admin.role-management is NOT excluded
      // This replaces the deprecated is_admin flag
      isAdmin = !isResourceExcluded(excludedFeatures, 'admin.role-management');
      
      // Admin role has all permissions
      if (isAdmin) {
        canEditMembers = true;
        canManageCommunications = true;
      } else {
        // Check if permissions are NOT excluded (hierarchical check)
        canEditMembers = !isResourceExcluded(excludedFeatures, 'admin_can_edit_members');
        canManageCommunications = !isResourceExcluded(excludedFeatures, 'admin_can_manage_communications');
      }
    }

    // Check if member has a linked tenant_user account (for SaaS admin access)
    let hasTenantUserLink = false;
    if (supabase) {
      const { data: link } = await supabase
        .from('tenant_user_member_link')
        .select('id')
        .eq('member_id', member.id)
        .maybeSingle();
      
      hasTenantUserLink = !!link;
    }

    // Return member with permission flags
    return res.json({ ...member, isAdmin, canEditMembers, canManageCommunications, hasTenantUserLink });
  } catch (error) {
    console.error('Auth me error:', error);
    return res.status(500).json({ error: 'Failed to get user' });
  }
}
