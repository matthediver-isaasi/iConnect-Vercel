import { getSessionTenantUser } from '../_lib/session.js';

const XERO_CLIENT_ID = process.env.XERO_CLIENT_ID;
const XERO_REDIRECT_URI = process.env.XERO_REDIRECT_URI;

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

  if (!XERO_CLIENT_ID) {
    return res.status(503).json({ error: 'Xero not configured' });
  }

  const scopes = [
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
    `&client_id=${XERO_CLIENT_ID}` +
    `&redirect_uri=${encodeURIComponent(XERO_REDIRECT_URI || '')}` +
    `&scope=${encodeURIComponent(scopes)}` +
    `&state=${state}`;

  res.json({ authUrl });
}
