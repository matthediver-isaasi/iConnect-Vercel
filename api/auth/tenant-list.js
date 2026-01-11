import { getSession } from '../_lib/session.js';
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

  if (!supabase) {
    return res.status(503).json({ error: 'Database not configured' });
  }

  try {
    const session = await getSession(req);
    
    if (!session) {
      return res.status(401).json({ success: false, error: 'Authentication required' });
    }

    // Support both tenant_user sessions (admin) and member sessions (portal)
    const isTenantUser = session.userType === 'tenant_user';
    const isMember = session.userType === 'member' || session.memberId;

    if (!isTenantUser && !isMember) {
      return res.status(401).json({ success: false, error: 'Authentication required' });
    }

    // Get identity ID from session - different sources depending on session type
    let identityId = session.identityId;
    
    console.log('[Tenant List] Session:', { 
      userType: session.userType, 
      identityId: session.identityId,
      tenantUserId: session.tenantUserId,
      tenantId: session.tenantId 
    });
    
    if (!identityId && isMember && session.memberId) {
      // For member sessions, look up identity from member record
      const { data: memberData } = await supabase
        .from('member')
        .select('identity_id')
        .eq('id', session.memberId)
        .single();
      identityId = memberData?.identity_id;
    }
    
    if (!identityId && isTenantUser) {
      identityId = session.tenantUserId;
    }

    console.log('[Tenant List] Using identityId:', identityId);

    const currentTenantId = session.tenantId;

    const { data: memberships, error: membershipError } = await supabase
      .from('tenant_membership')
      .select('*, tenant:tenant_id(*)')
      .eq('identity_id', identityId)
      .eq('status', 'active')
      .order('is_default', { ascending: false })
      .order('last_accessed', { ascending: false, nullsFirst: false });

    console.log('[Tenant List] Memberships query result:', { 
      count: memberships?.length || 0, 
      error: membershipError,
      identityId 
    });

    // If tenant_membership has no results or errors, fall back to tenant_user table
    if (membershipError || !memberships?.length) {
      console.log('[Tenant List] Falling back to tenant_user table');
      
      // Only fall back by identity_id (secure linkage), not email
      let legacyUsers = [];
      if (identityId) {
        const { data: usersByIdentity } = await supabase
          .from('tenant_user')
          .select('*, tenant:tenant_id(*)')
          .eq('identity_id', identityId)
          .eq('status', 'active');
        if (usersByIdentity?.length) {
          legacyUsers = usersByIdentity;
        }
      }

      console.log('[Tenant List] Legacy users found by identity:', legacyUsers.length);

      if (!legacyUsers?.length) {
        return res.json({
          success: true,
          tenants: [],
          currentTenantId
        });
      }

      return res.json({
        success: true,
        tenants: legacyUsers.map(u => ({
          id: u.tenant_id,
          name: u.tenant?.name,
          slug: u.tenant?.slug,
          logo_url: u.tenant?.logo_url,
          role: u.role,
          membership_type: 'owner',
          is_current: u.tenant_id === currentTenantId
        })),
        currentTenantId
      });
    }

    res.json({
      success: true,
      tenants: (memberships || []).map(m => ({
        id: m.tenant_id,
        name: m.tenant?.name,
        slug: m.tenant?.slug,
        logo_url: m.tenant?.logo_url,
        role: m.role,
        membership_type: m.membership_type || 'owner',
        is_default: m.is_default,
        is_current: m.tenant_id === currentTenantId,
        last_accessed: m.last_accessed
      })),
      currentTenantId
    });
  } catch (error) {
    console.error('[Tenant List] Error:', error);
    res.status(500).json({ success: false, error: 'Failed to list tenants' });
  }
}
