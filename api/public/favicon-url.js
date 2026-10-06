import { resolvePageTenant } from '../_lib/pageTenantResolver.js';
import { safeFaviconUrl } from '../../shared/tenantFavicon.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('Vary', 'Host, X-Forwarded-Host');
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  try {
    const tenant = await resolvePageTenant(req);
    return res.json({ faviconUrl: safeFaviconUrl(tenant?.favicon_url) || '/platform-icon.svg' });
  } catch {
    return res.status(503).json({ error: 'Favicon unavailable' });
  }
}
