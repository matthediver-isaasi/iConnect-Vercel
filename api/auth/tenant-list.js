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
    
    if (!session || !session.data) {
      return res.status(401).json({ success: false, error: 'Authentication required' });
    }

    // Extract session data
    const sessionData = session.data;

    // Support both tenant_user sessions (admin) and member sessions (portal)
    const isTenantUser = sessionData.userType === 'tenant_user';
    const isMember = sessionData.userType === 'member' || sessionData.memberId;

    if (!isTenantUser && !isMember) {
      return res.status(401).json({ success: false, error: 'Authentication required' });
    }

    // Get identity ID from session - different sources depending on session type
    let identityId = sessionData.identityId;
    
    console.log('[Tenant List] Session:', { 
      userType: sessionData.userType, 
      identityId: sessionData.identityId,
      tenantUserId: sessionData.tenantUserId,
      tenantId: sessionData.tenantId 
    });
    
    if (!identityId && isMember && sessionData.memberId) {
      // For member sessions, look up identity from member record
      const { data: memberData } = await supabase
        .from('member')
        .select('identity_id')
        .eq('id', sessionData.memberId)
        .single();
      identityId = memberData?.identity_id;
    }
    
    if (!identityId && isTenantUser) {
      identityId = sessionData.tenantUserId;
    }

    console.log('[Tenant List] Using identityId:', identityId);

    const currentTenantId = sessionData.tenantId;

    // Query both tenant_membership AND tenant_user tables, then merge results
    // This handles the case where some tenants only exist in tenant_user (legacy)
    
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

    // Also query tenant_user table by identity_id
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

    // Build a map of all tenants, preferring tenant_membership data over tenant_user
    const tenantMap = new Map();

    // First add legacy tenant_user records
    for (const u of legacyUsers) {
      tenantMap.set(u.tenant_id, {
        id: u.tenant_id,
        name: u.tenant?.name,
        slug: u.tenant?.slug,
        logo_url: u.tenant?.logo_url,
        role: u.role,
        membership_type: 'owner',
        is_current: u.tenant_id === currentTenantId
      });
    }

    // Then overlay with tenant_membership records (these take precedence)
    for (const m of (memberships || [])) {
      tenantMap.set(m.tenant_id, {
        id: m.tenant_id,
        name: m.tenant?.name,
        slug: m.tenant?.slug,
        logo_url: m.tenant?.logo_url,
        role: m.role,
        membership_type: m.membership_type || 'owner',
        is_default: m.is_default,
        is_current: m.tenant_id === currentTenantId,
        last_accessed: m.last_accessed
      });
    }

    const allTenants = Array.from(tenantMap.values());
    
    // Sort: is_default first, then by name
    allTenants.sort((a, b) => {
      if (a.is_default && !b.is_default) return -1;
      if (!a.is_default && b.is_default) return 1;
      return (a.name || '').localeCompare(b.name || '');
    });

    console.log('[Tenant List] Total tenants found:', allTenants.length);

    res.json({
      success: true,
      tenants: allTenants,
      currentTenantId
    });
  } catch (error) {
    console.error('[Tenant List] Error:', error);
    res.status(500).json({ success: false, error: 'Failed to list tenants' });
  }
}
