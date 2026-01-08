import { createSession } from '../_lib/session.js';
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

    await createSession(res, {
      memberId: member.id,
      memberEmail: member.email,
      organizationId: member.organization_id,
      tenantId: member.organization?.tenant_id,
      roleId: member.role_id,
      userType: 'member'
    });

    const landingPage = member.role?.default_landing_page || 'Dashboard';
    
    console.log(`[Portal SSO] Successfully logged in member ${member.id} from SSO token`);
    
    res.redirect(`/${landingPage}`);
  } catch (error) {
    console.error('[Portal SSO] Error:', error);
    res.redirect('/login?error=sso_failed');
  }
}
