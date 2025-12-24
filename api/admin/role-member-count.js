import { createClient } from '@supabase/supabase-js';
import { getSessionMember } from '../_lib/session.js';

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
    return res.status(503).json({ error: 'Supabase not configured' });
  }

  try {
    const member = await getSessionMember(req);
    
    if (!member) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const { roleId, organizationId } = req.query;

    if (!roleId) {
      return res.status(400).json({ error: 'roleId is required' });
    }

    const targetOrganizationId = organizationId || member.organization_id;

    if (!targetOrganizationId) {
      return res.status(400).json({ error: 'organizationId is required' });
    }

    const { data: members, error, count } = await supabase
      .from('member')
      .select('id, email, first_name, last_name', { count: 'exact' })
      .eq('role_id', roleId)
      .eq('organization_id', targetOrganizationId)
      .not('email', 'is', null);

    if (error) {
      console.error('[RoleMemberCount] Error:', error);
      return res.status(500).json({ error: 'Failed to fetch member count' });
    }

    const membersWithEmail = (members || []).filter(m => m.email && m.email.trim() !== '');

    return res.json({
      count: membersWithEmail.length,
      roleId,
      organizationId: targetOrganizationId,
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
