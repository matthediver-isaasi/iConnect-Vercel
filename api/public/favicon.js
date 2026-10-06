import { resolvePageTenant } from '../_lib/pageTenantResolver.js';
import { safeFaviconUrl } from '../../shared/tenantFavicon.js';

export function createFaviconHandler({ resolveTenant = resolvePageTenant } = {}) {
  return async (req, res) => {
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('Vary', 'Host, X-Forwarded-Host');
    if (!['GET', 'HEAD'].includes(req.method)) return res.status(405).end();
    try {
      const tenant = await resolveTenant(req);
      let target = safeFaviconUrl(tenant?.favicon_url);
      if (target && /^https?:/.test(target)) {
        const host = req.headers['x-forwarded-host'] || req.headers.host;
        const url = new URL(target);
        if (url.host === host && url.pathname === '/favicon.ico') target = null;
      }
      res.setHeader('Location', target || '/platform-icon.svg');
      return res.status(302).end();
    } catch {
      res.setHeader('Location', '/platform-icon.svg');
      return res.status(302).end();
    }
  };
}
export default createFaviconHandler();
