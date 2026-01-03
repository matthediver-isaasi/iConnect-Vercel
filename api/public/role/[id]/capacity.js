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
    const { id: roleId } = req.query;
    
    if (!roleId) {
      return res.status(400).json({ error: 'Role ID required' });
    }

    console.log(`[Role Capacity Check] Checking capacity for role: ${roleId}`);

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

    const { count, error: countError } = await supabase
      .from('member')
      .select('*', { count: 'exact', head: true })
      .eq('role_id', roleId)
      .eq('login_enabled', true);

    if (countError) {
      console.error('Error counting members:', countError);
      return res.status(500).json({ error: 'Failed to count members' });
    }

    const currentCount = count || 0;
    const hasCapacity = currentCount < role.max_members;

    console.log(`[Role Capacity Check] Role ${role.name}: ${currentCount}/${role.max_members} members, hasCapacity: ${hasCapacity}`);

    return res.json({
      hasCapacity,
      currentCount,
      maxMembers: role.max_members,
      roleName: role.name
    });
  } catch (error) {
    console.error('Role capacity check error:', error);
    return res.status(500).json({ error: 'Failed to check role capacity' });
  }
}
