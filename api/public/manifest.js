import { resolvePageTenant } from '../_lib/pageTenantResolver.js';

export function createManifestHandler({ resolveTenant = resolvePageTenant } = {}) {
  return async (req, res) => {
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('Vary', 'Host, X-Forwarded-Host');
    if (!['GET', 'HEAD'].includes(req.method)) {
      res.setHeader('Allow', 'GET, HEAD');
      return res.status(405).end();
    }
    let tenant;
    try { tenant = await resolveTenant(req, { fresh: true }); } catch {}
    const name = tenant?.name || 'iConn';
    const body = JSON.stringify({
      name, short_name: name,
      icons: [192, 512].map(size => ({ src: `/favicon-${size}.png`, sizes: `${size}x${size}`, type: 'image/png' })),
      theme_color: /^#[0-9a-f]{3}(?:[0-9a-f]{3})?$/i.test(tenant?.primary_color || '') ? tenant.primary_color : '#5C0085',
      background_color: '#ffffff', display: 'standalone', start_url: '/',
    });
    res.setHeader('Content-Type', 'application/manifest+json');
    res.setHeader('Content-Length', String(Buffer.byteLength(body)));
    return res.status(200).end(req.method === 'HEAD' ? undefined : body);
  };
}
export default createManifestHandler();
