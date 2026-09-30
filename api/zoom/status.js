import { getTenantIdFromSession, getTenantZoomCredentials } from '../_lib/zoomClient.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const tenantId = await getTenantIdFromSession(req);
  if (!tenantId) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  try {
    const credentials = await getTenantZoomCredentials(tenantId);
    const connected = !!credentials;

    return res.json({ connected });
  } catch (error) {
    console.error('[Zoom Status] Error:', error.message);
    return res.json({ connected: false });
  }
}
