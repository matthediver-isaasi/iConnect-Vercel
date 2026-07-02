import { resolveTenantFromRequest } from '../_lib/tenantResolver.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const tenant = await resolveTenantFromRequest(req);

    if (!tenant) {
      return res.status(200).json({
        tenant: null,
        message: 'No tenant found for this domain'
      });
    }

    return res.status(200).json({
      tenant: {
        id: tenant.id,
        name: tenant.name,
        slug: tenant.slug,
        domain: tenant.domain,
        logoUrl: tenant.logo_url,
        faviconUrl: tenant.favicon_url,
        primaryColor: tenant.primary_color,
        settings: tenant.settings || {}
      }
    });

  } catch (err) {
    console.error('[Get Current Tenant] Error:', err);
    return res.status(500).json({ error: 'Failed to get tenant info' });
  }
}
