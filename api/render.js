import { renderTenantHtml } from './_lib/renderHtml.js';
import { applyUnknownPageHttpPolicy } from './_lib/unknownPageHttp.js';

export function createHtmlHandler({ applyPolicy = applyUnknownPageHttpPolicy, renderHtml = renderTenantHtml } = {}) {
return async function handler(req, res) {
  if (await applyPolicy(req, res)) return;
  try {
    const html = await renderHtml(req);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    // Short SSR cache keyed on host so unfurl bots see fresh tenant data quickly
    const host = req.headers['x-forwarded-host'] || req.headers.host || '';
    res.setHeader('Vary', 'Host, X-Forwarded-Host');
    res.setHeader('Cache-Control', req.pageRouteOutcome
      ? 'private, no-store' : 'public, max-age=0, s-maxage=60, stale-while-revalidate=300');
    res.setHeader('X-Tenant-Host', host);
    return res.status(req.pageRouteOutcome === 'missing' ? 404 : 200).send(html);
  } catch (err) {
    console.error('[api/render] failed:', err);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'private, no-store');
    return res.status(req.pageRouteOutcome === 'missing' ? 404 : 503).send('<!DOCTYPE html><html><head><title>iConn</title></head><body><div id="root"></div></body></html>');
  }
};
}

export default createHtmlHandler();
