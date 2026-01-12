import crypto from 'crypto';
import { getSessionTenantUser } from '../_lib/session.js';
import { supabase } from '../_lib/database.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const origin = req.headers.origin || '';
  const referer = req.headers.referer || '';
  const host = req.headers.host || '';
  
  // Allow requests from iconn.app and any *.iconn.app subdomain
  const isIconnAppOrigin = (url) => {
    if (!url) return false;
    try {
      const parsed = new URL(url);
      return parsed.hostname === 'iconn.app' || 
             parsed.hostname === 'www.iconn.app' ||
             parsed.hostname.endsWith('.iconn.app');
    } catch {
      return false;
    }
  };
  
  let isAllowedOrigin = isIconnAppOrigin(origin);
  let isAllowedReferer = !referer || isIconnAppOrigin(referer);
  
  if (process.env.NODE_ENV === 'development') {
    isAllowedOrigin = isAllowedOrigin || origin.startsWith('http://localhost:5000') || origin.startsWith(`http://${host}`);
    isAllowedReferer = isAllowedReferer || !referer || referer.startsWith('http://localhost:5000');
  }
  
  if (!isAllowedOrigin && origin) {
    console.log('[Portal Session] CSRF blocked - invalid origin:', origin);
    return res.status(403).json({ error: 'Forbidden' });
  }

  if (!isAllowedReferer) {
    console.log('[Portal Session] CSRF blocked - invalid referer:', referer);
    return res.status(403).json({ error: 'Forbidden' });
  }

  if (!supabase) {
    return res.status(503).json({ error: 'Database not configured' });
  }

  const tenantUser = await getSessionTenantUser(req);
  
  if (!tenantUser) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const { data: link, error: linkError } = await supabase
      .from('tenant_user_member_link')
      .select('member_id')
      .eq('tenant_user_id', tenantUser.id)
      .eq('tenant_id', tenantUser.tenant_id)
      .single();

    if (linkError || !link) {
      return res.status(404).json({ 
        error: 'No portal access configured',
        message: 'Your SaaS account is not linked to a portal member account'
      });
    }

    const { data: member, error: memberError } = await supabase
      .from('member')
      .select('id, email, first_name, last_name, login_enabled, status')
      .eq('id', link.member_id)
      .single();

    if (memberError || !member) {
      return res.status(404).json({ error: 'Linked member account not found' });
    }

    if (!member.login_enabled || member.status !== 'active') {
      return res.status(403).json({ error: 'Portal access is disabled for this account' });
    }

    const { data: tenant, error: tenantError } = await supabase
      .from('tenant')
      .select('slug, domain, status')
      .eq('id', tenantUser.tenant_id)
      .single();

    if (tenantError || !tenant) {
      return res.status(404).json({ error: 'Tenant not found' });
    }

    if (tenant.status !== 'active') {
      return res.status(403).json({ error: 'Tenant is not active' });
    }

    const ssoToken = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000);

    const { error: tokenError } = await supabase
      .from('portal_sso_token')
      .insert({
        token: ssoToken,
        tenant_user_id: tenantUser.id,
        member_id: member.id,
        tenant_id: tenantUser.tenant_id,
        expires_at: expiresAt.toISOString()
      });

    if (tokenError) {
      console.error('[Portal Session] Error creating SSO token:', tokenError);
      return res.status(500).json({ error: 'Failed to create portal session' });
    }

    const portalDomain = tenant.domain || `${tenant.slug}.iconn.app`;
    const portalUrl = `https://${portalDomain}/api/auth/portal-sso?token=${ssoToken}`;

    console.log(`[Portal Session] SSO token created for tenant_user ${tenantUser.id} -> member ${member.id}`);

    res.json({ 
      success: true, 
      redirectUrl: portalUrl,
      expiresAt: expiresAt.toISOString()
    });
  } catch (error) {
    console.error('[Portal Session] Error:', error);
    res.status(500).json({ error: 'Failed to create portal session' });
  }
}
