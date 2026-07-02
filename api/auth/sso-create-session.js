import { createSession } from '../_lib/session.js';
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
    const { identityId, tenantId, tenantUserId } = req.body;

    if (!identityId || !tenantId || !tenantUserId) {
      return res.status(400).json({ 
        success: false, 
        error: 'Missing required fields: identityId, tenantId, tenantUserId' 
      });
    }

    console.log('[SSO Create Session] Creating session for identity:', identityId, 'tenant:', tenantId);

    const { data: tenantUser, error: tenantUserError } = await supabase
      .from('tenant_user')
      .select('*, tenant:tenant_id(*)')
      .eq('id', tenantUserId)
      .eq('tenant_id', tenantId)
      .eq('status', 'active')
      .single();

    if (tenantUserError || !tenantUser) {
      console.error('[SSO Create Session] Tenant user not found:', tenantUserError);
      return res.status(404).json({ success: false, error: 'Tenant user not found' });
    }

    if (tenantUser.identity_id && tenantUser.identity_id !== identityId) {
      console.error('[SSO Create Session] Identity mismatch:', tenantUser.identity_id, '!=', identityId);
      return res.status(403).json({ success: false, error: 'Identity mismatch' });
    }

    const { data: identity } = await supabase
      .from('tenant_identity')
      .select('*')
      .eq('id', identityId)
      .single();

    await createSession(res, {
      tenantUserId: tenantUser.id,
      tenantUserEmail: tenantUser.email,
      tenantId: tenantUser.tenant_id,
      identityId: identityId,
      userType: 'tenant_user'
    }, { req });

    console.log('[SSO Create Session] Session created for:', tenantUser.email, 'tenant:', tenantUser.tenant?.name);

    res.json({
      success: true,
      tenantUser: {
        id: tenantUser.id,
        email: tenantUser.email,
        first_name: identity?.first_name || tenantUser.first_name,
        last_name: identity?.last_name || tenantUser.last_name,
        role: tenantUser.role
      },
      tenant: tenantUser.tenant
    });
  } catch (error) {
    console.error('[SSO Create Session] Error:', error);
    res.status(500).json({ success: false, error: 'Failed to create session' });
  }
}
