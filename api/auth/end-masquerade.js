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
    if (!session) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    if (!session.data?.isMasquerading) {
      return res.status(400).json({ error: 'Not currently masquerading' });
    }

    const adminTenantUserId = session.data.masqueradeAdminTenantUserId;
    const adminTenantId = session.data.masqueradeAdminTenantId;
    const adminIdentityId = session.data.masqueradeAdminIdentityId;

    if (!adminTenantUserId) {
      return res.status(400).json({ error: 'Original admin session data not found' });
    }

    const { data: tenantUser, error: tuError } = await supabase
      .from('tenant_user')
      .select('id, email, first_name, last_name, role, tenant_id, identity_id')
      .eq('id', adminTenantUserId)
      .single();

    if (tuError || !tenantUser) {
      return res.status(404).json({ error: 'Original admin account not found' });
    }

    let adminMemberId = null;
    let adminMemberEmail = null;
    let adminOrganizationId = null;
    let adminRoleId = null;

    if (adminIdentityId) {
      const { data: adminMember } = await supabase
        .from('member')
        .select('id, email, organization_id, role_id')
        .eq('identity_id', adminIdentityId)
        .eq('tenant_id', adminTenantId)
        .single();

      if (adminMember) {
        adminMemberId = adminMember.id;
        adminMemberEmail = adminMember.email;
        adminOrganizationId = adminMember.organization_id;
        adminRoleId = adminMember.role_id;
      }
    }

    const adminSessionData = {
      tenantUserId: tenantUser.id,
      tenantUserEmail: tenantUser.email,
      tenantId: adminTenantId,
      userType: 'tenant_user',
      identityId: adminIdentityId || tenantUser.identity_id,
      memberId: adminMemberId,
      memberEmail: adminMemberEmail,
      organizationId: adminOrganizationId,
      roleId: adminRoleId,
    };

    const newSession = await createSession(res, adminSessionData, {
      req,
      replaceSessionId: session.id,
    });

    if (!newSession) {
      return res.status(500).json({ error: 'Failed to restore admin session' });
    }

    console.log(`[Masquerade] Admin "${tenantUser.first_name} ${tenantUser.last_name}" (${tenantUser.id}) ended masquerade session`);

    return res.status(200).json({
      success: true,
      admin: {
        id: tenantUser.id,
        email: tenantUser.email,
        firstName: tenantUser.first_name,
        lastName: tenantUser.last_name,
      },
    });

  } catch (error) {
    console.error('[End Masquerade] Error:', error);
    return res.status(500).json({ error: error.message });
  }
}
