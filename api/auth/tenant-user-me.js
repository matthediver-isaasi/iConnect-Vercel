import { getSessionTenantUser } from '../_lib/session.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const tenantUser = await getSessionTenantUser(req);

    if (!tenantUser) {
      return res.json({ authenticated: false });
    }

    res.json({
      authenticated: true,
      tenantUser: {
        id: tenantUser.id,
        email: tenantUser.email,
        first_name: tenantUser.first_name,
        last_name: tenantUser.last_name,
        role: tenantUser.role,
        status: tenantUser.status
      },
      tenant: tenantUser.tenant
    });
  } catch (error) {
    console.error('[Tenant Auth] Me error:', error);
    res.status(500).json({ error: 'Failed to get session' });
  }
}
