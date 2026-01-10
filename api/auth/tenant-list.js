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
    
    if (!session || session.userType !== 'tenant_user') {
      return res.status(401).json({ success: false, error: 'Authentication required' });
    }

    const identityId = session.identityId || session.tenantUserId;
    const currentTenantId = session.tenantId;

    const { data: memberships, error: membershipError } = await supabase
      .from('tenant_membership')
      .select('*, tenant:tenant_id(*)')
      .eq('identity_id', identityId)
      .eq('status', 'active')
      .order('is_default', { ascending: false })
      .order('last_accessed', { ascending: false, nullsFirst: false });

    if (membershipError) {
      const { data: legacyUsers, error: legacyError } = await supabase
        .from('tenant_user')
        .select('*, tenant:tenant_id(*)')
        .eq('identity_id', identityId)
        .eq('status', 'active');

      if (legacyError || !legacyUsers?.length) {
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
