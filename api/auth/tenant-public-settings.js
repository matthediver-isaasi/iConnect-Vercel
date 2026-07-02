import { resolveTenantFromRequest } from '../_lib/tenantResolver.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const tenant = await resolveTenantFromRequest(req);
    console.log('[Tenant Public Settings] Resolved tenant:', tenant ? { id: tenant.id, name: tenant.name, slug: tenant.slug } : null);
    
    if (!tenant) {
      console.log('[Tenant Public Settings] No tenant found, returning default enabled=true');
      return res.json({
        success: true,
        settings: {
          member_google_login_enabled: true
        }
      });
    }

    const settings = tenant.settings || {};
    const isEnabled = settings.member_google_login_enabled !== false;
    console.log('[Tenant Public Settings] Tenant settings:', { member_google_login_enabled: settings.member_google_login_enabled, isEnabled });
    
    return res.json({
      success: true,
      tenantId: tenant.id,
      tenantName: tenant.name,
      settings: {
        member_google_login_enabled: isEnabled
      }
    });
  } catch (error) {
    console.error('[Tenant Public Settings] Error:', error);
    return res.status(500).json({ error: 'Failed to fetch tenant settings' });
  }
}
