import { renderTenantHtml } from './_lib/renderHtml.js';

export default async function handler(req, res) {
  try {
    const html = await renderTenantHtml(req);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    // Short SSR cache keyed on host so unfurl bots see fresh tenant data quickly
    const host = req.headers['x-forwarded-host'] || req.headers.host || '';
    res.setHeader('Vary', 'Host, X-Forwarded-Host');
    res.setHeader('Cache-Control', 'public, max-age=0, s-maxage=60, stale-while-revalidate=300');
    res.setHeader('X-Tenant-Host', host);
    return res.status(200).send(html);
  } catch (err) {
    console.error('[api/render] failed:', err);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.status(200).send('<!DOCTYPE html><html><head><title>iConn</title></head><body><div id="root"></div></body></html>');
  }
}
