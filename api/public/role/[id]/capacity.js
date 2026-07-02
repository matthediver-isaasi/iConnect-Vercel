import { createClient } from '@supabase/supabase-js';

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
    const { id: roleId, orgKey, orgValue, orgId } = req.query;
    
    if (!roleId) {
      return res.status(400).json({ error: 'Role ID required' });
    }

    console.log(`[Role Capacity Check] Checking capacity for role: ${roleId}`);
    console.log(`[Role Capacity Check] Organization lookup - orgId: ${orgId}, key: ${orgKey}, value: ${orgValue}`);

    const { data: role, error: roleError } = await supabase
      .from('role')
      .select('id, name, max_members')
      .eq('id', roleId)
      .single();

    if (roleError) {
      console.error('Error fetching role:', roleError);
      return res.status(404).json({ error: 'Role not found' });
    }

    if (role.max_members === null || role.max_members === undefined) {
      console.log(`[Role Capacity Check] Role ${roleId} has no capacity limit`);
      return res.json({
        hasCapacity: true,
        currentCount: 0,
        maxMembers: null,
        roleName: role.name
      });
    }

    // If orgId is provided directly, use it for lookup (most efficient)
    if (orgId) {
      console.log(`[Role Capacity Check] Performing per-organization check using orgId: ${orgId}`);
      
      // Verify org exists
      const { data: org, error: orgError } = await supabase
        .from('organization')
        .select('id, name')
        .eq('id', orgId)
        .single();
      
      if (orgError || !org) {
        console.error('Error finding organization by ID:', orgError);
        return res.status(404).json({ error: 'Organization not found' });
      }
      
      console.log(`[Role Capacity Check] Found organization: ${org.id} (${org.name})`);

      // Count active members with this role in THIS organization only
      const { count, error: countError } = await supabase
        .from('member')
        .select('*', { count: 'exact', head: true })
        .eq('role_id', roleId)
        .eq('organization_id', org.id)
        .eq('login_enabled', true);

      if (countError) {
        console.error('Error counting org members:', countError);
        return res.status(500).json({ error: 'Failed to count members' });
      }

      const currentCount = count || 0;
      const hasCapacity = currentCount < role.max_members;

      console.log(`[Role Capacity Check] Org ${org.name}: ${currentCount}/${role.max_members} active ${role.name} members, hasCapacity: ${hasCapacity}`);

      return res.json({
        hasCapacity,
        currentCount,
        maxMembers: role.max_members,
        roleName: role.name,
        debug: {
          mode: 'per_organization',
          organizationId: org.id,
          organizationName: org.name,
          activeMembersWithRoleInOrg: currentCount
        }
      });
    }

    // If org lookup params provided, check per-organization capacity
    if (orgKey && orgValue) {
      console.log(`[Role Capacity Check] Performing per-organization check for ${orgKey}=${orgValue}`);
      
      // Find the organization by the uniqueness key
      let orgQuery = supabase.from('organization').select('id, name');
      
      // Handle different org uniqueness keys
      if (orgKey === 'name') {
        orgQuery = orgQuery.eq('name', orgValue);
      } else {
        // For custom fields, we need to search in custom_fields JSONB
        // The custom field value would be stored like: custom_fields->>orgKey = orgValue
        orgQuery = orgQuery.eq(`custom_fields->>${orgKey}`, orgValue);
      }
      
      const { data: orgs, error: orgError } = await orgQuery.limit(1);
      
      if (orgError) {
        console.error('Error finding organization:', orgError);
        return res.status(500).json({ error: 'Failed to find organization' });
      }

      // If organization doesn't exist yet, capacity is available
      if (!orgs || orgs.length === 0) {
        console.log(`[Role Capacity Check] Organization not found - new org, capacity available`);
        return res.json({
          hasCapacity: true,
          currentCount: 0,
          maxMembers: role.max_members,
          roleName: role.name,
          debug: {
            mode: 'per_organization',
            orgKey,
            orgValue,
            organizationFound: false,
            message: 'Organization does not exist yet - capacity available for new org'
          }
        });
      }

      const org = orgs[0];
      console.log(`[Role Capacity Check] Found organization: ${org.id} (${org.name})`);

      // Count active members with this role in THIS organization only
      const { count, error: countError } = await supabase
        .from('member')
        .select('*', { count: 'exact', head: true })
        .eq('role_id', roleId)
        .eq('organization_id', org.id)
        .eq('login_enabled', true);

      if (countError) {
        console.error('Error counting org members:', countError);
        return res.status(500).json({ error: 'Failed to count members' });
      }

      const currentCount = count || 0;
      const hasCapacity = currentCount < role.max_members;

      console.log(`[Role Capacity Check] Org ${org.name}: ${currentCount}/${role.max_members} active ${role.name} members, hasCapacity: ${hasCapacity}`);

      return res.json({
        hasCapacity,
        currentCount,
        maxMembers: role.max_members,
        roleName: role.name,
        debug: {
          mode: 'per_organization',
          orgKey,
          orgValue,
          organizationId: org.id,
          organizationName: org.name,
          organizationFound: true,
          activeMembersWithRoleInOrg: currentCount
        }
      });
    }

    // Role capacity is ALWAYS per-organization - no global fallback
    // If org params are missing, return an error
    console.log(`[Role Capacity Check] ERROR: Missing organization context - orgKey and orgValue are required`);
    
    return res.status(400).json({
      error: 'Organization context required for role capacity check',
      hasCapacity: false,
      currentCount: 0,
      maxMembers: role.max_members,
      roleName: role.name,
      missingOrgContext: true,
      debug: {
        message: 'Role capacity is per-organization. Please provide orgKey and orgValue parameters.'
      }
    });
  } catch (error) {
    console.error('Role capacity check error:', error);
    return res.status(500).json({ error: 'Failed to check role capacity' });
  }
}
