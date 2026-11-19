import { getSession, createSession, getSessionTenantUser } from '../_lib/session.js';
import { supabase } from '../_lib/database.js';
import { normalizeInternalReturnTo } from '../../shared/safeReturnTo.js';

export function createEndMasqueradeHandler({
  db = supabase, readSession = getSession, issueSession = createSession,
  readTenantUser = getSessionTenantUser,
} = {}) {
return async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
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

  if (!db) {
    return res.status(503).json({ error: 'Database not configured' });
  }

  try {
    const session = await readSession(req);
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
    const returnUrl = normalizeInternalReturnTo(session.data.masqueradeReturnUrl, '/members');

    if (!adminTenantId || (!adminTenantUserId && !adminMemberId)) {
      return res.status(400).json({ error: 'Original admin session data not found' });
    }

    let adminSessionData;
    let adminDisplayName = 'Admin';

    if (!adminTenantUserId && adminMemberId) {
      const { data: adminMember, error: amError } = await db
        .from('member')
        .select('id, email, first_name, last_name, organization_id, tenant_id, role_id, identity_id, login_enabled')
        .eq('id', adminMemberId)
        .eq('tenant_id', adminTenantId)
        .single();

      if (amError || !adminMember) {
        return res.status(404).json({ error: 'Original admin member account not found' });
      }
      if (adminMember.login_enabled === false) {
        return res.status(403).json({ error: 'Original account access has been disabled' });
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
      // Unified administrators need not have a legacy tenant_user row.
      // Revalidate only the saved original identity, never the viewed member.
      const tenantUser = await readTenantUser(req, { id: session.id, data: {
        userType: 'tenant_user', tenantUserId: adminTenantUserId,
        identityId: adminIdentityId, tenantId: adminTenantId,
      } });
      if (!tenantUser || tenantUser.tenant_id !== adminTenantId || tenantUser.status !== 'active') {
        return res.status(403).json({ error: 'Original admin account is no longer available' });
      }

      adminDisplayName = tenantUser.first_name
        ? `${tenantUser.first_name} ${tenantUser.last_name || ''}`.trim()
        : tenantUser.email;

      let adminMemberIdForSession = null;
      let adminMemberEmail = null;
      let adminOrganizationId = null;
      let adminRoleId = null;

      const lookupIdentityId = adminIdentityId || tenantUser.identity_id
        || (tenantUser._isUnifiedIdentity ? tenantUser.id : null);
      if (lookupIdentityId) {
        const { data: linkedMember, error: linkError } = await db
          .from('member')
          .select('id, email, organization_id, role_id')
          .eq('identity_id', lookupIdentityId)
          .eq('tenant_id', adminTenantId)
          .maybeSingle();
        if (linkError) throw linkError;

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

    const newSession = await issueSession(res, adminSessionData, {
      req,
      replaceSessionId: session.id,
    });

    if (!newSession) {
      return res.status(500).json({ error: 'Failed to restore admin session' });
    }

    console.log(`[Masquerade] Admin "${adminDisplayName}" ended masquerade session`);

    return res.status(200).json({
      success: true,
      returnUrl,
      admin: {
        name: adminDisplayName,
      },
    });

  } catch (error) {
    console.error('[End Masquerade] Error:', error);
    return res.status(503).json({ error: 'Unable to restore your admin session. Please try again.' });
  }
}
}
export default createEndMasqueradeHandler();
