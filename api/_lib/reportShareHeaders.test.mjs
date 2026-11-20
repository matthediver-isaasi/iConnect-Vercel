import test from 'node:test';
import assert from 'node:assert/strict';
import { renderTenantHtml } from './renderHtml.js';
import { createHtmlHandler } from '../render.js';
import { isSharedReportPage } from './reportShareHeaders.js';
import { matchesRegisteredRoute } from '../../shared/registeredRoutes.js';
test('shared HTML has no report data, capability canonical or tenant tracking injection before authentication', async () => {
  let resolved = false;
  const html = await renderTenantHtml({ url: '/shared-reports/secret-capability', headers: {} }, {
    template: '<html><head><title>App</title></head><body><div id="root"></div></body></html>',
    resolveTenant: async () => { resolved = true; throw new Error('Must not resolve tenant metadata'); },
  });
  assert.equal(resolved, false);
  assert.match(html, /noindex/);
  assert.match(html, /no-referrer/);
  assert.doesNotMatch(html, /secret-capability/);
  assert.equal(matchesRegisteredRoute('/shared-reports/a.secret'), true);
});
test('HTML cache/index protection honors Vercel original URLs and bypasses unknown-page redirects', async () => {
  const headers = {}, req = { url: '/api/render', headers: { 'x-original-uri': '/shared-reports/secret-link' } };
  const res = { setHeader(k, v) { headers[k] = v; }, status(code) { this.code = code; return this; }, send(html) { this.html = html; } };
  assert.equal(isSharedReportPage(req), true);
  const handler = createHtmlHandler({
    applyPolicy: async () => { throw new Error('The capability URL must not be treated as a missing CMS page'); },
    renderHtml: async () => '<html>Shared report</html>',
  });
  await handler(req, res);
  assert.equal(res.code, 200);
  assert.equal(headers['CDN-Cache-Control'], 'no-store');
  assert.equal(headers['Vercel-CDN-Cache-Control'], 'no-store');
  assert.match(headers['Cache-Control'], /no-store/);
  assert.match(headers['X-Robots-Tag'], /noindex/);
  assert.equal(headers['Referrer-Policy'], 'no-referrer');
});
