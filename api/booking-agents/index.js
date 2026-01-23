import { createClient } from '@supabase/supabase-js';
import { getSessionTenantUser } from '../_lib/session.js';

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

export default async function handler(req, res) {
  const session = await getSessionTenantUser(req, res);
  if (!session) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const supabase = createClient(supabaseUrl, supabaseServiceKey);
  const { tenantId } = session;

  if (req.method === 'GET') {
    try {
      const { data, error } = await supabase
        .from('tenant_identity')
        .select(`
          id,
          email,
          first_name,
          last_name,
          booking_slug,
          is_booking_agent
        `)
        .eq('tenant_id', tenantId)
        .order('first_name', { ascending: true });

      if (error) {
        console.error('[booking-agents] Fetch error:', error);
        return res.status(500).json({ error: 'Failed to fetch team members' });
      }

      const agents = (data || []).filter(m => m.is_booking_agent === true);
      const allMembers = data || [];

      return res.json({ agents, allMembers });
    } catch (err) {
      console.error('[booking-agents] Error:', err);
      return res.status(500).json({ error: 'Internal server error' });
    }
  }

  if (req.method === 'POST') {
    try {
      const { identity_id, is_booking_agent } = req.body;

      if (!identity_id) {
        return res.status(400).json({ error: 'Identity ID is required' });
      }

      const { data: identity, error: fetchError } = await supabase
        .from('tenant_identity')
        .select('id, tenant_id')
        .eq('id', identity_id)
        .eq('tenant_id', tenantId)
        .single();

      if (fetchError || !identity) {
        return res.status(404).json({ error: 'Team member not found' });
      }

      const { data, error } = await supabase
        .from('tenant_identity')
        .update({ is_booking_agent: is_booking_agent === true })
        .eq('id', identity_id)
        .eq('tenant_id', tenantId)
        .select()
        .single();

      if (error) {
        console.error('[booking-agents] Update error:', error);
        return res.status(500).json({ error: 'Failed to update agent status' });
      }

      return res.json({ agent: data });
    } catch (err) {
      console.error('[booking-agents] Error:', err);
      return res.status(500).json({ error: 'Internal server error' });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
