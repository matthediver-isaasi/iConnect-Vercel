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
        .select('is_admin, excluded_features')
        .eq('id', member.role_id)
        .single();
      
      isAdmin = role?.is_admin === true;
      const excludedFeatures = role?.excluded_features || [];
      
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

    // Return member with permission flags
    return res.json({ ...member, isAdmin, canEditMembers, canManageCommunications });
  } catch (error) {
    console.error('Auth me error:', error);
    return res.status(500).json({ error: 'Failed to get user' });
  }
}
