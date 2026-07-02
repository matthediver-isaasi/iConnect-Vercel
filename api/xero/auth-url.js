import { getSessionTenantUser } from '../_lib/session.js';
import { getXeroCredentials } from '../_lib/xeroCredentials.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const tenantUser = await getSessionTenantUser(req);
  
  if (!tenantUser) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const xeroCredentials = await getXeroCredentials(tenantUser.tenant_id);
    
    if (!xeroCredentials || !xeroCredentials.client_id) {
      return res.status(503).json({ error: 'Xero not configured. Please add your Xero credentials in Admin > Integrations.' });
    }

    if (!xeroCredentials.is_enabled) {
      return res.status(403).json({ error: 'Xero integration is disabled. Please enable it in Admin > Integrations.' });
    }

    const XERO_REDIRECT_URI = `${req.headers['x-forwarded-proto'] || 'https'}://${req.headers.host}/api/xero/callback`;

    const scopes = [
      'offline_access',
      'openid',
      'profile', 
      'email',
      'accounting.transactions',
      'accounting.contacts',
      'accounting.settings.read'
    ].join(' ');

    const state = Buffer.from(JSON.stringify({ 
      tenantId: tenantUser.tenant_id 
    })).toString('base64');

    const authUrl = `https://login.xero.com/identity/connect/authorize?` +
      `response_type=code` +
      `&client_id=${xeroCredentials.client_id}` +
      `&redirect_uri=${encodeURIComponent(XERO_REDIRECT_URI)}` +
      `&scope=${encodeURIComponent(scopes)}` +
      `&state=${state}`;

    res.json({ authUrl });
  } catch (error) {
    console.error('[Xero Auth URL] Error:', error);
    res.status(500).json({ error: error.message || 'Failed to generate auth URL' });
  }
}
