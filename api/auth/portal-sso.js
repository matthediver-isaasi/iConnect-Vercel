import { getSession, createSession, updateSession } from '../_lib/session.js';
import { supabase } from '../_lib/database.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!supabase) {
    return res.status(503).json({ error: 'Database not configured' });
  }

  const { token } = req.query;

  if (!token) {
    return res.redirect('/login?error=invalid_token');
  }

  try {
    const { data: ssoToken, error: tokenError } = await supabase
      .from('portal_sso_token')
      .select('*')
      .eq('token', token)
      .is('used_at', null)
      .single();

    if (tokenError || !ssoToken) {
      console.log('[Portal SSO] Token not found or already used');
      return res.redirect('/login?error=invalid_token');
    }

    if (new Date(ssoToken.expires_at) < new Date()) {
      console.log('[Portal SSO] Token expired');
      await supabase.from('portal_sso_token').delete().eq('id', ssoToken.id);
      return res.redirect('/login?error=token_expired');
    }

    await supabase
      .from('portal_sso_token')
      .update({ used_at: new Date().toISOString() })
      .eq('id', ssoToken.id);

    const { data: member, error: memberError } = await supabase
      .from('member')
      .select(`
        id, email, first_name, last_name, login_enabled, status,
        role_id, organization_id,
        role:role_id(id, name, excluded_features, default_landing_page),
        organization:organization_id(id, name, tenant_id)
      `)
      .eq('id', ssoToken.member_id)
      .single();

    if (memberError || !member) {
      console.log('[Portal SSO] Member not found:', ssoToken.member_id);
      return res.redirect('/login?error=account_not_found');
    }

    if (!member.login_enabled || member.status !== 'active') {
      console.log('[Portal SSO] Member account disabled');
      return res.redirect('/login?error=account_disabled');
    }

    // Check if there's an existing session with admin context to preserve
    const existingSession = await getSession(req);
    const preserveAdminContext = existingSession?.data?.tenantUserId && existingSession?.data?.userType === 'tenant_user';
    
    if (preserveAdminContext) {
      // Update existing session to add member context while preserving admin context
      const updatedSessionData = {
        ...existingSession.data,
        // Add member context
        memberId: member.id,
        memberEmail: member.email,
        organizationId: member.organization_id,
        roleId: member.role_id,
        // Switch active context to member for portal use
        userType: 'member',
        // Preserve admin context for return (including identityId and tenantId)
        preservedTenantUserId: existingSession.data.tenantUserId,
        preservedTenantUserEmail: existingSession.data.tenantUserEmail,
        preservedIdentityId: existingSession.data.identityId,
        preservedTenantId: existingSession.data.tenantId,
        preservedTenantUserType: 'tenant_user'
      };
      
      console.log(`[Portal SSO] Preserving admin context:`, {
        sessionId: existingSession.id?.substring(0, 8),
        originalTenantUserId: existingSession.data.tenantUserId,
        originalIdentityId: existingSession.data.identityId,
        newMemberId: member.id,
        preservedTenantUserId: updatedSessionData.preservedTenantUserId,
        preservedIdentityId: updatedSessionData.preservedIdentityId
      });
      
      await updateSession(existingSession.id, updatedSessionData);
      console.log(`[Portal SSO] Updated session to add member context, preserved admin context for tenant_user ${existingSession.data.tenantUserId}`);
    } else {
      // No admin session found via cookie (may be on custom domain where iconn.app cookies aren't sent)
      // Check if SSO token has tenant_user_id - this indicates the session was initiated from admin area
      let sessionData = {
        memberId: member.id,
        memberEmail: member.email,
        organizationId: member.organization_id,
        tenantId: member.organization?.tenant_id,
        roleId: member.role_id,
        userType: 'member'
      };
      
      // If SSO token has tenant_user_id, derive preserved admin context from it
      if (ssoToken.tenant_user_id) {
        console.log(`[Portal SSO] SSO token has tenant_user_id, fetching admin context for Admin Dashboard link`);
        
        const { data: tenantUser } = await supabase
          .from('tenant_user')
          .select('id, email, identity_id, tenant_id')
          .eq('id', ssoToken.tenant_user_id)
          .single();
        
        if (tenantUser) {
          sessionData.preservedTenantUserId = tenantUser.id;
          sessionData.preservedTenantUserEmail = tenantUser.email;
          sessionData.preservedIdentityId = tenantUser.identity_id;
          sessionData.preservedTenantId = tenantUser.tenant_id;
          sessionData.preservedTenantUserType = 'tenant_user';
          
          console.log(`[Portal SSO] Derived admin context from SSO token:`, {
            preservedTenantUserId: tenantUser.id,
            preservedIdentityId: tenantUser.identity_id
          });
        }
      }
      
      await createSession(res, sessionData, { req });
      console.log(`[Portal SSO] Created member session for ${member.id}`, 
        sessionData.preservedTenantUserId ? `with preserved admin context for tenant_user ${sessionData.preservedTenantUserId}` : '(no admin context)');
    }

    const landingPage = member.role?.default_landing_page || 'Dashboard';
    
    console.log(`[Portal SSO] Successfully logged in member ${member.id} from SSO token`);
    
    res.redirect(`/${landingPage}`);
  } catch (error) {
    console.error('[Portal SSO] Error:', error);
    res.redirect('/login?error=sso_failed');
  }
}
