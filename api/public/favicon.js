import { resolvePageTenant } from '../_lib/pageTenantResolver.js';
import { tenantFaviconImage } from '../_lib/faviconImage.js';
import { faviconSize, FAVICON_PATHS } from '../../shared/tenantFavicon.js';

export function createFaviconHandler({ resolveTenant = resolvePageTenant, image = tenantFaviconImage } = {}) {
  return async (req, res) => {
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('Vary', 'Host, X-Forwarded-Host');
    if (!['GET', 'HEAD'].includes(req.method)) {
      res.setHeader('Allow', 'GET, HEAD');
      return res.status(405).end();
    }
    let tenant = null;
    try {
      tenant = await resolveTenant(req, { fresh: true });
    } catch {}
    const requestedPath = String(req.url || '').split('?')[0];
    const size = faviconSize(FAVICON_PATHS.includes(requestedPath) ? requestedPath :
      req.headers['x-original-uri'] || req.query?.path);
    const bytes = await image(tenant, size);
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Length', String(bytes.length));
    return res.status(200).end(req.method === 'HEAD' ? undefined : bytes);
  };
}
export default createFaviconHandler();
