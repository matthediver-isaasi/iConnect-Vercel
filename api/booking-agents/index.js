import { createClient } from '@supabase/supabase-js';
import { getTenantContext } from '../_lib/tenantContext.js';

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

export default async function handler(req, res) {
  const tenantContext = await getTenantContext(req);
  if (!tenantContext || !tenantContext.isAuthenticated) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const supabase = createClient(supabaseUrl, supabaseServiceKey);
  const tenantId = tenantContext.tenantId;

  // Validate tenantId
  if (!tenantId || tenantId === 'undefined') {
    console.error('[booking-agents] Invalid tenantId:', tenantId);
    return res.status(400).json({ error: 'Invalid tenant context' });
  }

  if (req.method === 'GET') {
    try {
      // First, find the primary organization for this tenant
      const { data: primaryOrg, error: orgError } = await supabase
        .from('organization')
        .select('id')
        .eq('tenant_id', tenantId)
        .eq('is_primary', true)
        .single();

      if (orgError || !primaryOrg) {
        console.error('[booking-agents] Primary org not found:', orgError);
        return res.status(404).json({ error: 'Primary organization not found' });
      }

      // Query via tenant_membership to get identities whose member belongs to primary org
      const { data: memberships, error } = await supabase
        .from('tenant_membership')
        .select(`
          identity_id,
          member:member_id (
            id,
            organization_id
          ),
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

      // Filter to only members belonging to the primary organization
      const identityMap = new Map();
      for (const m of memberships || []) {
        if (m.tenant_identity && m.member && m.member.organization_id === primaryOrg.id) {
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

      // Find the primary organization for this tenant
      const { data: primaryOrg, error: orgError } = await supabase
        .from('organization')
        .select('id')
        .eq('tenant_id', tenantId)
        .eq('is_primary', true)
        .single();

      if (orgError || !primaryOrg) {
        return res.status(404).json({ error: 'Primary organization not found' });
      }

      // Verify the identity belongs to primary org via membership
      const { data: membership, error: membershipError } = await supabase
        .from('tenant_membership')
        .select(`
          identity_id,
          member:member_id (
            id,
            organization_id
          )
        `)
        .eq('tenant_id', tenantId)
        .eq('identity_id', identity_id)
        .eq('status', 'active')
        .single();

      if (membershipError || !membership) {
        return res.status(404).json({ error: 'Team member not found in this tenant' });
      }

      // Verify member belongs to primary organization
      if (!membership.member || membership.member.organization_id !== primaryOrg.id) {
        return res.status(403).json({ error: 'Only members of the tenant organization can be booking agents' });
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
