import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { evaluateTenantOverride } from './tenantHostGuard.js';
import { createPageTenantResolver } from './pageTenantResolver.js';
import { createTenantBrandingHandler } from '../public/tenant-branding.js';
import { resolveTenantBrandingPayload } from './tenantBranding.js';
import { micrositeBrandingValue } from './microsites.js';
import { safeFaviconUrl } from '../../shared/tenantFavicon.js';
import { buildGoogleFontsHref } from './installedFontsShared.js';

// Separate module evaluation gives reader/writer independent process-local Maps.
const source = readFileSync(new URL('./tenantResolver.js', import.meta.url), 'utf8');
function resolver(db) {
  return new Function('supabase', 'evaluateTenantOverride', source
    .replace(/^import .*;$/gm, '').replace(/^export /gm, '')
    + '\nreturn { resolveTenantFromHost, resolveTenantFromRequest, getHostFromRequest, clearTenantCache };'
  )(db, evaluateTenantOverride);
}

function fixture() {
  const state = {
    row: { id: 'fixture', slug: 'fixture', domain: 'fixture.example', status: 'active',
      name: 'Fixture', footer_source: 'configured',
      header_config: { mobileHeaderHeight: 80, topBarHeight: 90, logoHeight: 112 } },
    reads: 0, error: null, legacy: false,
  };
  const db = {
    from(table) {
      assert.equal(table, 'tenant');
      let fields;
      const filters = {};
      const q = {
        select(value) { fields = value; return q; },
        eq(key, value) { filters[key] = value; return q; },
        async single() {
          state.reads++;
          if (state.error) return { data: null, error: state.error };
          if (state.legacy && fields.includes('canvas_footer_id')) {
            return { data: null, error: { code: '42703', message: 'column canvas_footer_id does not exist' } };
          }
          if (!Object.entries(filters).every(([k, v]) => state.row[k] === v)) {
            return { data: null, error: { code: 'PGRST116' } };
          }
          const data = structuredClone(state.row);
          if (state.legacy) { delete data.footer_source; delete data.canvas_footer_id; }
          return { data, error: null };
        },
      };
      return q;
    },
  };
  return { state, db, reader: resolver(db), writer: resolver(db) };
}
const request = (query = {}, host = 'www.fixture.example') => ({
  method: 'GET', headers: { host }, query, url: '/Events',
});
async function api(f, req = request(), microsite = null) {
  const res = {
    statusCode: 200, headers: {},
    setHeader(k, v) { this.headers[k] = v; },
    status(c) { this.statusCode = c; return this; },
    json(body) { this.body = body; return this; },
  };
  await createTenantBrandingHandler({
    db: f.db, resolveTenant: f.reader.resolveTenantFromRequest,
    resolveViewer: async () => ({ allowMemberOnlyContent: false }),
    resolveMicrosite: async () => microsite,
  })(req, res);
  return res;
}

const renderSource = readFileSync(new URL('./renderHtml.js', import.meta.url), 'utf8');
function render(f, microsite = null) {
  const resolvePageTenant = createPageTenantResolver({
    resolveHost: f.reader.resolveTenantFromHost,
    resolveRequest: f.reader.resolveTenantFromRequest,
  });
  return new Function('getHostFromRequest', 'resolvePageTenant', 'supabase',
    'resolveEntityMeta', 'homepageRoute', 'resolveTenantBrandingPayload',
    'micrositeBrandingValue', 'safeFaviconUrl', 'buildGoogleFontsHref',
    'resolveMicrositeByPrefix', 'resolveScopedTypographyStyles',
    renderSource.replace(/^import .*;$/gm, '').replace(/^export /gm, '')
      + '\nreturn renderTenantHtml;'
  )(f.reader.getHostFromRequest, resolvePageTenant, {
    from() {
      const q = { select() { return q; }, eq() { return q; }, order() { return q; },
        then(resolve) { return Promise.resolve({ data: [], error: null }).then(resolve); } };
      return q;
    },
  }, async () => null,
    async () => ({ root: false }), resolveTenantBrandingPayload,
    micrositeBrandingValue, safeFaviconUrl, buildGoogleFontsHref,
    async () => microsite, () => []);
}

test('independent writer cannot clear reader cache; next API and SSR reads use 200 immediately', async () => {
  const f = fixture();
  assert.equal((await api(f)).body.branding.headerConfig.mobileHeaderHeight, 80);
  f.state.row.header_config.mobileHeaderHeight = 200;
  f.writer.clearTenantCache();
  assert.equal((await f.reader.resolveTenantFromHost('www.fixture.example')).header_config.mobileHeaderHeight, 80);
  const before = f.state.reads;
  const host = await api(f);
  const explicit = await api(f, request({ tenant: 'fixture' }));
  assert.deepEqual(host.body, explicit.body);
  assert.equal(host.body.branding.headerConfig.mobileHeaderHeight, 200);
  assert.equal(f.state.reads - before, 2, 'one authoritative read per API request');
  assert.match(host.headers['Cache-Control'], /no-store/);
  const beforeHtml = f.state.reads;
  const html = await render(f)(request(), { template: '<html><head></head><body></body></html>' });
  assert.match(html, /Fixture/);
  assert.equal(f.state.reads - beforeHtml, 1, 'SSR refreshes once, not once per branding consumer');
});

test('fresh microsite inherits current height and preserves explicit overrides', async () => {
  const f = fixture();
  await api(f);
  f.state.row.header_config.mobileHeaderHeight = 200;
  const ms = { id: 'ms', path_prefix: 'site', footer_source: 'inherit', header_config: { topBarHeight: 96 } };
  const response = await api(f, request({ microsite: 'site' }), ms);
  assert.equal(response.body.branding.headerConfig.mobileHeaderHeight, 200);
  assert.equal(response.body.branding.headerConfig.topBarHeight, 96);
  const html = await render(f, ms)(request({ microsite: 'site' }), {
    template: '<html><head></head><body></body></html>',
  });
  const injected = JSON.parse(html.match(/window\.__MICROSITE_CONTEXT__=(.*?)<\/script>/)[1]);
  assert.deepEqual(injected.branding, JSON.parse(JSON.stringify(response.body.branding)));
  ms.header_config.mobileHeaderHeight = 128;
  assert.equal((await api(f, request({ microsite: 'site' }), ms)).body.branding.headerConfig.mobileHeaderHeight, 128);
});

test('legacy footer columns retain fresh branding compatibility', async () => {
  const f = fixture();
  await api(f);
  f.state.legacy = true;
  f.state.row.header_config.mobileHeaderHeight = 200;
  assert.equal((await api(f)).body.branding.headerConfig.mobileHeaderHeight, 200);
});

test('authoritative failures never return the warmed branding, including SSR', async () => {
  for (const error of [{ code: '08006' }, { code: '42703', message: 'column header_config missing' }]) {
    const f = fixture();
    await api(f);
    f.state.error = error;
    assert.equal((await api(f)).statusCode, 500);
    assert.equal((await api(f, request({ tenant: 'fixture' }))).statusCode, 500);
    await assert.rejects(render(f)(request(), { template: '<html><head></head></html>' }), /current tenant branding/);
  }
});

test('active-tenant and wildcard host authority survive freshness reads', async () => {
  const f = fixture();
  const req = request({ tenant: 'other' }, 'fixture.iconn.app');
  await api(f, req);
  f.state.row.header_config.mobileHeaderHeight = 200;
  assert.equal((await api(f, req)).body.branding.headerConfig.mobileHeaderHeight, 200);
  f.state.row.status = 'inactive';
  const response = await api(f, req);
  assert.equal(response.statusCode, 500);
  assert.equal(response.body.branding, undefined);
});

test('cold authoritative database failures are not misreported as an unknown site', async () => {
  const f = fixture();
  f.state.error = { code: '08006' };
  assert.equal((await api(f)).statusCode, 500);
});
