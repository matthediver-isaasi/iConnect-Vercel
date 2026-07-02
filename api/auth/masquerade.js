import { getSession, createSession } from '../_lib/session.js';
import { getTenantContext } from '../_lib/tenantContext.js';
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

    const ctx = await getTenantContext(req);
    if (!ctx.isAuthenticated || !ctx.tenantId) {
      return res.status(403).json({ error: 'Admin access required' });
    }

    const tenantId = ctx.tenantId;
    const adminTenantUserId = ctx.tenantUserId || null;

    const { memberId, returnUrl } = req.body;
    if (!memberId) {
      return res.status(400).json({ error: 'memberId is required' });
    }

    let hasPermission = false;

    const adminRoleId = ctx.roleId || session.data?.roleId;
    const adminMemberId = ctx.memberId || session.data?.memberId;

    if (adminRoleId) {
      const { data: role } = await supabase
        .from('role')
        .select('excluded_features')
        .eq('id', adminRoleId)
        .single();

      const excludedFeatures = role?.excluded_features || [];
      hasPermission = !excludedFeatures.includes('crm.members.masquerade');
    }

    if (!hasPermission && adminMemberId && !adminRoleId) {
      const { data: adminMember } = await supabase
        .from('member')
        .select('role_id')
        .eq('id', adminMemberId)
        .single();

      if (adminMember?.role_id) {
        const { data: role } = await supabase
          .from('role')
          .select('excluded_features')
          .eq('id', adminMember.role_id)
          .single();

        const excludedFeatures = role?.excluded_features || [];
        hasPermission = !excludedFeatures.includes('crm.members.masquerade');
      }
    }

    if (!hasPermission && adminTenantUserId) {
      const { data: tenantUser } = await supabase
        .from('tenant_user')
        .select('role')
        .eq('id', adminTenantUserId)
        .single();

      if (tenantUser?.role === 'owner' || tenantUser?.role === 'admin') {
        hasPermission = true;
      }
    }

    if (!hasPermission) {
      return res.status(403).json({ error: 'You do not have permission to masquerade as a member' });
    }

    const { data: targetMember, error: memberError } = await supabase
      .from('member')
      .select('id, email, first_name, last_name, organization_id, tenant_id, role_id, login_enabled, identity_id')
      .eq('id', memberId)
      .single();

    if (memberError || !targetMember) {
      return res.status(404).json({ error: 'Member not found' });
    }

    if (targetMember.login_enabled === false) {
      return res.status(400).json({ error: 'Cannot masquerade as a member whose login is disabled' });
    }

    const memberTenantId = targetMember.tenant_id;
    if (memberTenantId && memberTenantId !== tenantId) {
      return res.status(403).json({ error: 'Cannot masquerade as a member from a different tenant' });
    }

    if (!memberTenantId) {
      const { data: org } = await supabase
        .from('organisation')
        .select('tenant_id')
        .eq('id', targetMember.organization_id)
        .single();

      if (org?.tenant_id !== tenantId) {
        return res.status(403).json({ error: 'Cannot masquerade as a member from a different tenant' });
      }
    }

    let adminName = 'Admin';
    if (adminTenantUserId) {
      const { data: tu } = await supabase
        .from('tenant_user')
        .select('first_name, last_name, email')
        .eq('id', adminTenantUserId)
        .single();
      if (tu) {
        adminName = tu.first_name ? `${tu.first_name} ${tu.last_name || ''}`.trim() : tu.email;
      }
    } else if (adminMemberId) {
      const { data: am } = await supabase
        .from('member')
        .select('first_name, last_name, email')
        .eq('id', adminMemberId)
        .single();
      if (am) {
        adminName = am.first_name ? `${am.first_name} ${am.last_name || ''}`.trim() : am.email;
      }
    }

    const masqueradeSessionData = {
      memberId: targetMember.id,
      memberEmail: targetMember.email,
      organizationId: targetMember.organization_id || null,
      tenantId: tenantId,
      roleId: targetMember.role_id || null,
      identityId: targetMember.identity_id || null,
      userType: 'member',
      isMasquerading: true,
      masqueradeAdminSessionId: session.id,
      masqueradeAdminName: adminName,
      masqueradeAdminTenantUserId: adminTenantUserId,
      masqueradeAdminMemberId: adminMemberId,
      masqueradeAdminTenantId: tenantId,
      masqueradeAdminIdentityId: session.data?.identityId || null,
      masqueradeAdminUserType: session.data?.userType || 'member',
      masqueradeReturnUrl: returnUrl || '/members',
    };

    const newSession = await createSession(res, masqueradeSessionData, {
      req,
      replaceSessionId: session.id,
    });

    if (!newSession) {
      return res.status(500).json({ error: 'Failed to create masquerade session' });
    }

    console.log(`[Masquerade] Admin "${adminName}" masquerading as member "${targetMember.first_name} ${targetMember.last_name}" (${targetMember.id})`);

    return res.status(200).json({
      success: true,
      member: {
        id: targetMember.id,
        email: targetMember.email,
        firstName: targetMember.first_name,
        lastName: targetMember.last_name,
      },
    });

  } catch (error) {
    console.error('[Masquerade] Error:', error);
    return res.status(500).json({ error: error.message });
  }
}
