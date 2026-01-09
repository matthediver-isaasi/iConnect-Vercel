import { resolveTenantFromRequest } from '../_lib/tenantResolver.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const tenant = await resolveTenantFromRequest(req);
    
    if (!tenant) {
      return res.json({
        success: true,
        settings: {
          member_google_login_enabled: true
        }
      });
    }

    const settings = tenant.settings || {};
    
    return res.json({
      success: true,
      tenantId: tenant.id,
      tenantName: tenant.name,
      settings: {
        member_google_login_enabled: settings.member_google_login_enabled !== false
      }
    });
  } catch (error) {
    console.error('[Tenant Public Settings] Error:', error);
    return res.status(500).json({ error: 'Failed to fetch tenant settings' });
  }
}
