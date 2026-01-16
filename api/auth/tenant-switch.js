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
    
    if (!session || !session.data) {
      return res.status(401).json({ success: false, error: 'Authentication required' });
    }

    // Extract current session data
    const currentSessionData = session.data;

    // Support both tenant_user sessions (admin) and member sessions (portal)
    const isTenantUser = currentSessionData.userType === 'tenant_user';
    const isMember = currentSessionData.userType === 'member' || currentSessionData.memberId;

    if (!isTenantUser && !isMember) {
      return res.status(401).json({ success: false, error: 'Authentication required' });
    }

    // Get identity ID from session - different sources depending on session type
    let identityId = currentSessionData.identityId;
    
    if (!identityId && isMember && currentSessionData.memberId) {
      // For member sessions, look up identity from member record
      const { data: memberData } = await supabase
        .from('member')
        .select('identity_id')
        .eq('id', currentSessionData.memberId)
        .single();
      identityId = memberData?.identity_id;
    }
    
    // For tenant_user sessions, try to get identity from the tenant_user record
    if (!identityId && isTenantUser && currentSessionData.tenantUserId) {
      const { data: tenantUserData } = await supabase
        .from('tenant_user')
        .select('identity_id')
        .eq('id', currentSessionData.tenantUserId)
        .single();
      identityId = tenantUserData?.identity_id;
    }
    
    if (!identityId) {
      console.log('[Tenant Switch] Unable to determine identity ID from session');
      return res.status(401).json({ success: false, error: 'Session identity not found' });
    }
    
    console.log('[Tenant Switch] Using identity:', identityId, 'for tenant switch');

    const { tenantId } = req.body;

    if (!tenantId) {
      return res.status(400).json({ success: false, error: 'Tenant ID is required' });
    }

    // Primary approach: Look up tenant_user directly by identity_id
    // This is more reliable as it doesn't depend on tenant_membership schema
    const { data: tenantUser } = await supabase
      .from('tenant_user')
      .select('*, tenant:tenant_id(*)')
      .eq('identity_id', identityId)
      .eq('tenant_id', tenantId)
      .eq('status', 'active')
      .single();

    if (tenantUser) {
      // Create session with correct tenant_user.id (not identity_id)
      const sessionData = {
        identityId: tenantUser.identity_id || identityId,
        tenantUserId: tenantUser.id,  // Must be the actual tenant_user.id
        tenantUserEmail: tenantUser.email,
        tenantId: tenantUser.tenant_id,
        userType: 'tenant_user'
      };

      console.log('[Tenant Switch] Creating tenant_user session:', tenantUser.id, 'for tenant:', tenantUser.tenant?.slug);
      
      // Replace old session in one operation - domain uses host-based detection
      await createSession(res, sessionData, { replaceSessionId: session.id, req });

      return res.json({
        success: true,
        tenantUser: {
          id: tenantUser.id,
          email: tenantUser.email,
          first_name: tenantUser.first_name,
          last_name: tenantUser.last_name,
          role: tenantUser.role
        },
        tenant: tenantUser.tenant
      });
    }

    // Fallback: Try tenant_membership table (may have schema limitations)
    let membership = null;
    try {
      const { data } = await supabase
        .from('tenant_membership')
        .select('*, tenant:tenant_id(*), identity:identity_id(*)')
        .eq('identity_id', identityId)
        .eq('tenant_id', tenantId)
        .eq('status', 'active')
        .single();
      membership = data;
    } catch (err) {
      console.log('[Tenant Switch] Membership lookup failed (schema may need migration)');
    }

    if (!membership) {
      return res.status(403).json({ success: false, error: 'You do not have access to this tenant.' });
    }

    await supabase
      .from('tenant_membership')
      .update({ last_accessed: new Date().toISOString() })
      .eq('id', membership.id);

    // Determine session type based on membership_type
    const isOwnerMembership = membership.membership_type === 'owner' || membership.role === 'owner';
    
    let sessionData;
    let responseData;

    if (isOwnerMembership) {
      // Owner/admin - create tenant_user session
      sessionData = {
        identityId: membership.identity_id,
        tenantUserId: membership.identity_id,
        tenantUserEmail: membership.identity?.email,
        tenantId: membership.tenant_id,
        membershipId: membership.id,
        membershipRole: membership.role,
        userType: 'tenant_user'
      };
      
      responseData = {
        success: true,
        tenantUser: {
          id: membership.identity_id,
          email: membership.identity?.email,
          first_name: membership.identity?.first_name,
          last_name: membership.identity?.last_name,
          role: membership.role
        },
        tenant: membership.tenant
      };
    } else {
      // Member - create member session
      // Get the member record for this membership
      let memberId = membership.member_id;
      let member = null;
      
      if (memberId) {
        const { data: memberData } = await supabase
          .from('member')
          .select('*')
          .eq('id', memberId)
          .single();
        member = memberData;
      }
      
      // Fall back to finding member by identity_id and tenant
      if (!member) {
        const { data: memberData } = await supabase
          .from('member')
          .select('*')
          .eq('identity_id', membership.identity_id)
          .eq('tenant_id', membership.tenant_id)
          .single();
        member = memberData;
      }

      if (!member) {
        return res.status(404).json({ success: false, error: 'Member record not found for this tenant.' });
      }

      sessionData = {
        memberId: member.id,
        memberEmail: member.email,
        tenantId: membership.tenant_id,
        identityId: membership.identity_id,
        membershipId: membership.id,
        userType: 'member'
      };
      
      responseData = {
        success: true,
        member: {
          id: member.id,
          email: member.email,
          first_name: member.first_name,
          last_name: member.last_name
        },
        tenant: membership.tenant
      };
    }

    console.log('[Tenant Switch] Creating session with tenantId:', membership.tenant_id, 'type:', sessionData.userType);
    await createSession(res, sessionData, { req });

    console.log('[Tenant Switch] Switched to tenant:', membership.tenant?.name);

    res.json(responseData);
  } catch (error) {
    console.error('[Tenant Switch] Error:', error);
    res.status(500).json({ success: false, error: 'Failed to switch tenant' });
  }
}
