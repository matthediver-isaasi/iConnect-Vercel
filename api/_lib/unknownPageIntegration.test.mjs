import test from 'node:test';
import assert from 'node:assert/strict';
import { createRedirectResolver } from '../redirects/resolve.js';
import { createUnknownPageHttpPolicy } from './unknownPageHttp.js';
import { createPrerenderHandler } from '../public/prerender.js';
import { createHtmlHandler } from '../render.js';
import { createPageTenantResolver } from './pageTenantResolver.js';

const tenant = { id: 'a', name: 'Tenant', domain: 'tenant.test', settings: {
  allow_search_indexing: true, redirect_unknown_pages_to_homepage: true,
} };

function database({ enabled = true, form = null, errorTable = null, rules = [] } = {}) {
  const tables = {
    tenant: [{ ...tenant, status: 'active', settings: { redirect_unknown_pages_to_homepage: enabled } }],
    form: form ? [{ tenant_id: 'a', slug: 'join.html', is_active: true, ...form }] : [],
    redirect_mapping: rules,
  };
  return {
    from(table) {
      const filters = [];
      let single = false;
      const q = {
        select() { return q; }, order() { return q; }, limit() { return q; },
        eq(k, v) { filters.push([k, v]); return q; },
        ilike(k, v) { filters.push([k, v]); return q; },
        is(k, v) { filters.push([k, v]); return q; },
        in(k, v) { filters.push([k, v]); return q; },
        single() { single = true; return q; },
        maybeSingle() { single = true; return q; },
        then(resolve) {
          const matching = (tables[table] || []).filter(row => filters.every(([k, v]) => Array.isArray(v) ? v.includes(row[k]) : (row[k] ?? null) === v));
          return Promise.resolve({
            data: single ? matching[0] || null : matching,
            error: errorTable === table ? { code: '42P01', message: 'table unavailable' } : null,
          }).then(resolve);
        },
      };
      return q;
    },
  };
}
function response() {
  return {
    statusCode: 200, headers: {}, body: null,
    setHeader(k, v) { this.headers[k] = v; },
    getHeader(k) { return this.headers[k]; },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
    send(body) { this.body = body; return this; },
    end() { this.ended = true; return this; },
  };
}
async function run(path, options = {}, renderShell = async () => '<html>app shell</html>') {
  const db = database(options);
  const deps = { database: db, resolveTenant: async () => tenant, renderShell };
  const req = { method: 'GET', query: { path }, headers: { host: 'tenant.test' }, url: path };
  const endpoint = response();
  await createRedirectResolver(deps)(req, endpoint);
  const http = response();
  const handled = await createUnknownPageHttpPolicy(deps)(req, http);
  const crawler = response();
  await createPrerenderHandler(deps)(req, crawler);
  const html = response();
  await createHtmlHandler({ applyPolicy: createUnknownPageHttpPolicy(deps), renderHtml: async () => '<html>browser app</html>' })({ ...req }, html);
  return { endpoint, http, handled, crawler, req, html };
}

test('endpoint, direct HTTP and crawler agree for obsolete page extensions', async () => {
  for (const path of ['/old.html', '/old.aspx', '/old.php']) {
    const { endpoint, http, crawler, handled, html } = await run(path);
    assert.equal(endpoint.body.target_url, '/');
    assert.equal(endpoint.body.status_code, 302);
    assert.equal(handled, true);
    for (const res of [http, crawler, html]) {
      assert.equal(res.statusCode, 302);
      assert.equal(res.headers.Location, '/');
    }
  }
});

test('fresh disabled setting defeats stale cached enabled tenant on every entry point', async () => {
  const { endpoint, http, crawler, handled, html } = await run('/old.html', { enabled: false });
  assert.equal(endpoint.body.found, false);
  assert.equal(handled, false);
  for (const res of [http, crawler, html]) {
    assert.equal(res.statusCode, 404);
    assert.equal(res.headers.Location, undefined);
  }
});

test('restricted form survives broad mappings and homepage setting in all entry points', async () => {
  const { endpoint, http, crawler } = await run('/join.html', {
    form: { require_authentication: true },
    rules: [{ tenant_id: 'a', is_active: true, source_pattern: '/', target_url: '/Home', match_type: 'prefix' }],
  });
  assert.equal(endpoint.body.route_outcome, 'restricted');
  assert.equal(endpoint.body.found, false);
  for (const res of [http, crawler]) {
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers.Location, undefined);
  }
  assert.match(crawler.body, /app shell/);
});

test('missing legacy microsite schema never redirects or replaces browser shell', async () => {
  const { endpoint, http, handled, crawler, req, html } = await run('/old.html', { errorTable: 'microsite' });
  assert.equal(endpoint.statusCode, 503);
  assert.equal(handled, false);
  assert.equal(http.body, null);
  assert.equal(req.pageRouteOutcome, 'error');
  assert.equal(crawler.statusCode, 500);
  assert.equal(html.statusCode, 200);
  assert.match(html.body, /browser app/);
  for (const res of [endpoint, http, crawler]) assert.equal(res.headers.Location, undefined);
});

test('crawler shell-render failure for existing route cannot cause redirect', async () => {
  let rendered = false;
  const { endpoint, crawler } = await run('/Dashboard', {}, async () => { rendered = true; throw new Error('renderer failed'); });
  assert.equal(rendered, true);
  assert.equal(endpoint.body.route_outcome, 'existing');
  assert.equal(endpoint.body.found, false);
  assert.equal(crawler.statusCode, 500);
  assert.equal(crawler.headers.Location, undefined);
});

test('asset paths and non-GET methods do not trigger direct HTTP routing', async () => {
  for (const [method, url] of [['GET', '/old.js'], ['POST', '/old.html']]) {
    const res = response();
    assert.equal(await createUnknownPageHttpPolicy({
      resolveTenant: async () => { throw new Error('must not resolve'); },
    })({ method, url, headers: {} }, res), false);
    assert.equal(res.statusCode, 200);
  }
});

test('custom-domain host A overrides cross-tenant query on endpoint, HTTP and crawler', async () => {
  let overrideCalls = 0;
  const resolveTenant = createPageTenantResolver({
    resolveHost: async host => host === 'tenant.test' ? tenant : null,
    resolveRequest: async () => { overrideCalls++; return { id: 'b', settings: tenant.settings }; },
  });
  const deps = { database: database(), resolveTenant };
  const req = {
    method: 'GET', url: '/old.html?tenant=b', query: { path: '/old.html', tenant: 'b', domain: 'b.test', slug: 'b' },
    headers: { host: 'tenant.test' },
  };
  for (const handler of [createRedirectResolver(deps), createUnknownPageHttpPolicy(deps), createPrerenderHandler(deps)]) {
    const res = response();
    await handler({ ...req }, res);
    assert.equal(res.body?.target_url || res.headers.Location, '/');
  }
  assert.equal(overrideCalls, 0);
  assert.equal(await resolveTenant({ ...req, headers: { host: 'unknown.test' } }), null);
  assert.equal(overrideCalls, 0);
});

test('explicit development hosts retain tenant hint support, lookalikes do not', async () => {
  const resolveTenant = createPageTenantResolver({
    resolveHost: async () => null, resolveRequest: async req => ({ id: req.query.tenant }),
  });
  for (const host of ['localhost:5000', '127.0.0.1:5000', 'project.replit.dev']) {
    assert.deepEqual(await resolveTenant({ headers: { host }, query: { tenant: 'a' } }), { id: 'a' });
  }
  assert.equal(await resolveTenant({ headers: { host: 'project.replit.dev.evil.test' }, query: { tenant: 'a' } }), null);
});