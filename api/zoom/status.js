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
    const hasGlobalFallback = !!(process.env.ZOOM_ACCOUNT_ID && process.env.ZOOM_CLIENT_ID && process.env.ZOOM_CLIENT_SECRET);
    const connected = !!(credentials || hasGlobalFallback);

    return res.json({
      connected,
      source: credentials ? 'tenant' : hasGlobalFallback ? 'global' : 'none'
    });
  } catch (error) {
    console.error('[Zoom Status] Error:', error.message);
    return res.json({ connected: false, source: 'none' });
  }
}
