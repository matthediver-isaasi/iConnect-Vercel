import { getSessionTenantUser } from '../_lib/session.js';
import { getQuickBooksCredentials, getIntuitEndpoints } from '../_lib/quickbooksCredentials.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const tenantUser = await getSessionTenantUser(req);
  if (!tenantUser) return res.status(401).json({ error: 'Unauthorized' });

  try {
    const creds = await getQuickBooksCredentials(tenantUser.tenant_id);

    if (!creds || !creds.client_id) {
      return res.status(503).json({
        error: 'QuickBooks not configured. Please add your QuickBooks credentials in Admin > Integrations.',
      });
    }

    if (!creds.is_enabled) {
      return res.status(403).json({
        error: 'QuickBooks integration is disabled. Please enable it in Admin > Integrations.',
      });
    }

    const redirectUri =
      process.env.QUICKBOOKS_REDIRECT_URI ||
      `${req.headers['x-forwarded-proto'] || 'https'}://${req.headers.host}/api/quickbooks/callback`;

    const scopes = ['com.intuit.quickbooks.accounting', 'openid', 'profile', 'email'].join(' ');

    const state = Buffer.from(
      JSON.stringify({ tenantId: tenantUser.tenant_id, env: creds.environment }),
    ).toString('base64');

    const { authorizeUrl } = getIntuitEndpoints(creds.environment);
    const url =
      `${authorizeUrl}?` +
      `client_id=${encodeURIComponent(creds.client_id)}` +
      `&response_type=code` +
      `&scope=${encodeURIComponent(scopes)}` +
      `&redirect_uri=${encodeURIComponent(redirectUri)}` +
      `&state=${encodeURIComponent(state)}`;

    res.json({ authUrl: url });
  } catch (error) {
    console.error('[QBO Auth URL] Error:', error);
    res.status(500).json({ error: error.message || 'Failed to generate auth URL' });
  }
}
