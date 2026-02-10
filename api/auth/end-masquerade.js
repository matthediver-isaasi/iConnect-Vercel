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
    const adminMemberId = session.data.masqueradeAdminMemberId;
    const adminTenantId = session.data.masqueradeAdminTenantId;
    const adminIdentityId = session.data.masqueradeAdminIdentityId;
    const adminUserType = session.data.masqueradeAdminUserType || 'tenant_user';

    if (!adminTenantUserId && !adminMemberId) {
      return res.status(400).json({ error: 'Original admin session data not found' });
    }

    let adminSessionData;
    let adminDisplayName = 'Admin';

    if (adminUserType === 'member' || (!adminTenantUserId && adminMemberId)) {
      const { data: adminMember, error: amError } = await supabase
        .from('member')
        .select('id, email, first_name, last_name, organization_id, tenant_id, role_id, identity_id')
        .eq('id', adminMemberId)
        .single();

      if (amError || !adminMember) {
        return res.status(404).json({ error: 'Original admin member account not found' });
      }

      adminDisplayName = adminMember.first_name
        ? `${adminMember.first_name} ${adminMember.last_name || ''}`.trim()
        : adminMember.email;

      adminSessionData = {
        memberId: adminMember.id,
        memberEmail: adminMember.email,
        organizationId: adminMember.organization_id,
        tenantId: adminTenantId || adminMember.tenant_id,
        roleId: adminMember.role_id,
        identityId: adminIdentityId || adminMember.identity_id,
        userType: 'member',
      };
    } else {
      const { data: tenantUser, error: tuError } = await supabase
        .from('tenant_user')
        .select('id, email, first_name, last_name, role, tenant_id, identity_id')
        .eq('id', adminTenantUserId)
        .single();

      if (tuError || !tenantUser) {
        return res.status(404).json({ error: 'Original admin account not found' });
      }

      adminDisplayName = tenantUser.first_name
        ? `${tenantUser.first_name} ${tenantUser.last_name || ''}`.trim()
        : tenantUser.email;

      let adminMemberIdForSession = null;
      let adminMemberEmail = null;
      let adminOrganizationId = null;
      let adminRoleId = null;

      const lookupIdentityId = adminIdentityId || tenantUser.identity_id;
      if (lookupIdentityId) {
        const { data: linkedMember } = await supabase
          .from('member')
          .select('id, email, organization_id, role_id')
          .eq('identity_id', lookupIdentityId)
          .eq('tenant_id', adminTenantId)
          .single();

        if (linkedMember) {
          adminMemberIdForSession = linkedMember.id;
          adminMemberEmail = linkedMember.email;
          adminOrganizationId = linkedMember.organization_id;
          adminRoleId = linkedMember.role_id;
        }
      }

      adminSessionData = {
        tenantUserId: tenantUser.id,
        tenantUserEmail: tenantUser.email,
        tenantId: adminTenantId,
        userType: 'tenant_user',
        identityId: lookupIdentityId,
        memberId: adminMemberIdForSession,
        memberEmail: adminMemberEmail,
        organizationId: adminOrganizationId,
        roleId: adminRoleId,
      };
    }

    const newSession = await createSession(res, adminSessionData, {
      req,
      replaceSessionId: session.id,
    });

    if (!newSession) {
      return res.status(500).json({ error: 'Failed to restore admin session' });
    }

    console.log(`[Masquerade] Admin "${adminDisplayName}" ended masquerade session`);

    return res.status(200).json({
      success: true,
      admin: {
        name: adminDisplayName,
      },
    });

  } catch (error) {
    console.error('[End Masquerade] Error:', error);
    return res.status(500).json({ error: error.message });
  }
}
