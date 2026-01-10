import { getSession, createSession } from '../_lib/session.js';
import { supabase } from '../_lib/database.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!supabase) {
    return res.status(503).json({ error: 'Database not configured' });
  }

  try {
    const session = await getSession(req);
    
    if (!session || session.userType !== 'tenant_user') {
      return res.status(401).json({ success: false, error: 'Authentication required' });
    }

    const identityId = session.identityId || session.tenantUserId;
    const { tenantId } = req.body;

    if (!tenantId) {
      return res.status(400).json({ success: false, error: 'Tenant ID is required' });
    }

    const { data: membership, error: membershipError } = await supabase
      .from('tenant_membership')
      .select('*, tenant:tenant_id(*), identity:identity_id(*)')
      .eq('identity_id', identityId)
      .eq('tenant_id', tenantId)
      .eq('status', 'active')
      .single();

    if (membershipError || !membership) {
      const { data: legacyUser } = await supabase
        .from('tenant_user')
        .select('*, tenant:tenant_id(*)')
        .eq('identity_id', identityId)
        .eq('tenant_id', tenantId)
        .eq('status', 'active')
        .single();

      if (!legacyUser) {
        return res.status(403).json({ success: false, error: 'You do not have access to this tenant.' });
      }

      // Create session with all required fields for tenant isolation
      const legacySessionData = {
        identityId: legacyUser.identity_id || legacyUser.id,
        tenantUserId: legacyUser.id,
        tenantUserEmail: legacyUser.email,
        tenantId: legacyUser.tenant_id,  // Critical for tenant isolation
        userType: 'tenant_user'
      };

      console.log('[Tenant Switch] Creating legacy session with tenantId:', legacyUser.tenant_id);
      await createSession(res, legacySessionData);

      return res.json({
        success: true,
        tenantUser: {
          id: legacyUser.id,
          email: legacyUser.email,
          first_name: legacyUser.first_name,
          last_name: legacyUser.last_name,
          role: legacyUser.role
        },
        tenant: legacyUser.tenant
      });
    }

    await supabase
      .from('tenant_membership')
      .update({ last_accessed: new Date().toISOString() })
      .eq('id', membership.id);

    // Create session with all required fields for tenant isolation
    const sessionData = {
      identityId: membership.identity_id,
      tenantUserId: membership.identity_id,
      tenantUserEmail: membership.identity?.email,
      tenantId: membership.tenant_id,  // Critical for tenant isolation
      membershipId: membership.id,
      membershipRole: membership.role,
      userType: 'tenant_user'
    };

    console.log('[Tenant Switch] Creating session with tenantId:', membership.tenant_id);
    await createSession(res, sessionData);

    console.log('[Tenant Switch] Switched to tenant:', membership.tenant?.name);

    res.json({
      success: true,
      tenantUser: {
        id: membership.identity_id,
        email: membership.identity?.email,
        first_name: membership.identity?.first_name,
        last_name: membership.identity?.last_name,
        role: membership.role
      },
      tenant: membership.tenant
    });
  } catch (error) {
    console.error('[Tenant Switch] Error:', error);
    res.status(500).json({ success: false, error: 'Failed to switch tenant' });
  }
}
