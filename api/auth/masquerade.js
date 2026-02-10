import { getSession, getSessionTenantUser, createSession } from '../_lib/session.js';
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

    const tenantUser = await getSessionTenantUser(req);
    if (!tenantUser) {
      return res.status(403).json({ error: 'Admin access required' });
    }

    const dbTenantId = tenantUser.tenant_id;
    const sessionTenantId = tenantUser._sessionTenantId;
    
    if (sessionTenantId && dbTenantId && sessionTenantId !== dbTenantId) {
      console.error('[Masquerade] Tenant mismatch: session says', sessionTenantId, 'but DB says', dbTenantId);
      return res.status(403).json({ error: 'Session tenant mismatch' });
    }
    
    const tenantId = dbTenantId || sessionTenantId;

    const { memberId } = req.body;
    if (!memberId) {
      return res.status(400).json({ error: 'memberId is required' });
    }

    const adminRoleId = session.data?.roleId;
    const adminMemberId = session.data?.memberId;

    let hasPermission = false;

    if (adminMemberId && adminRoleId) {
      const { data: role } = await supabase
        .from('role')
        .select('excluded_features')
        .eq('id', adminRoleId)
        .single();

      const excludedFeatures = role?.excluded_features || [];
      hasPermission = !excludedFeatures.includes('crm.members.masquerade');
    }

    if (!hasPermission && adminMemberId) {
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

    if (!hasPermission) {
      if (tenantUser.role === 'owner' || tenantUser.role === 'admin') {
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

    const adminName = tenantUser.first_name
      ? `${tenantUser.first_name} ${tenantUser.last_name || ''}`.trim()
      : tenantUser.email;

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
      masqueradeAdminTenantUserId: tenantUser.id,
      masqueradeAdminTenantId: tenantId,
      masqueradeAdminIdentityId: session.data?.identityId || null,
    };

    const newSession = await createSession(res, masqueradeSessionData, {
      req,
      replaceSessionId: session.id,
    });

    if (!newSession) {
      return res.status(500).json({ error: 'Failed to create masquerade session' });
    }

    console.log(`[Masquerade] Admin "${adminName}" (${tenantUser.id}) masquerading as member "${targetMember.first_name} ${targetMember.last_name}" (${targetMember.id})`);

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
