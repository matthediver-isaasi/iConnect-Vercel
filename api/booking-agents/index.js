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

  // Validate tenantId
  if (!tenantId || tenantId === 'undefined') {
    console.error('[booking-agents] Invalid tenantId:', tenantId);
    return res.status(400).json({ error: 'Invalid tenant context' });
  }

  if (req.method === 'GET') {
    try {
      // Query via tenant_membership to get identities for this tenant
      const { data: memberships, error } = await supabase
        .from('tenant_membership')
        .select(`
          identity_id,
          tenant_identity:identity_id (
            id,
            email,
            first_name,
            last_name,
            booking_slug,
            is_booking_agent
          )
        `)
        .eq('tenant_id', tenantId)
        .eq('status', 'active');

      if (error) {
        console.error('[booking-agents] Fetch error:', error);
        return res.status(500).json({ error: 'Failed to fetch team members' });
      }

      // Flatten to get unique identities
      const identityMap = new Map();
      for (const m of memberships || []) {
        if (m.tenant_identity) {
          identityMap.set(m.tenant_identity.id, m.tenant_identity);
        }
      }
      
      const allMembers = Array.from(identityMap.values()).sort((a, b) => 
        (a.first_name || '').localeCompare(b.first_name || '')
      );
      const agents = allMembers.filter(m => m.is_booking_agent === true);

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

      // Verify the identity belongs to this tenant via membership
      const { data: membership, error: membershipError } = await supabase
        .from('tenant_membership')
        .select('identity_id')
        .eq('tenant_id', tenantId)
        .eq('identity_id', identity_id)
        .eq('status', 'active')
        .single();

      if (membershipError || !membership) {
        return res.status(404).json({ error: 'Team member not found in this tenant' });
      }

      const { data, error } = await supabase
        .from('tenant_identity')
        .update({ is_booking_agent: is_booking_agent === true })
        .eq('id', identity_id)
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
