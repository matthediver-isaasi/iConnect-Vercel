import test from 'node:test';
import assert from 'node:assert/strict';
import { homepageRoute, resolveHomepage, readHomepageSlug } from './homepage.js';
import { createUnknownPageHttpPolicy } from './unknownPageHttp.js';
import { createPrerenderHandler } from '../public/prerender.js';
import { renderTenantHtml } from './renderHtml.js';
import { createFaviconHandler } from '../public/favicon.js';
import middleware from '../../middleware.js';
import { createSitemapHandler } from '../public/sitemap.xml.js';

const tenant = { id: 'alpha', name: 'Alpha', domain: 'alpha.test',
  favicon_url: 'https://images.test/alpha.svg', settings: { allow_search_indexing: true } };
function fixture() {
  return {
    tenant: [tenant, { ...tenant, id: 'beta', settings: { home_page_slug: 'legacy' } }],
    system_settings: [
      { tenant_id: 'alpha', setting_key: 'public_home_page_slug', setting_value: 'welcome-one' },
      { tenant_id: 'beta', setting_key: 'public_home_page_slug', setting_value: 'second-two' },
    ],
    i_edit_page: ['welcome-one', 'second-two', 'legacy'].map((slug, index) => ({
      id: slug, tenant_id: index ? 'beta' : 'alpha', slug, microsite_id: null,
      status: 'published', layout_type: 'public', builder_type: 'ai_static',
      title: 'Welcome page', seo_title: 'Search title', seo_description: 'Search description',
      static_html: '<h2>Substantive guest homepage content</h2>', static_css: '',
    })),
  };
}
function database(tables, failTable) {
  return { from(table) {
    const filters = [];
    let single = false;
    const q = {
      select() { return q; }, order() { return q; }, limit() { return q; },
      eq(k, v) { filters.push(row => row[k] === v); return q; },
      is(k, v) { filters.push(row => (row[k] ?? null) === v); return q; },
      in(k, v) { filters.push(row => v.includes(row[k])); return q; },
      ilike(k, v) { filters.push(row => row[k]?.toLowerCase() === v.toLowerCase()); return q; },
      single() { single = true; return q; }, maybeSingle() { single = true; return q; },
      then(resolve) {
        const data = (tables[table] || []).filter(row => filters.every(f => f(row)));
        return Promise.resolve({ data: single ? data[0] || null : data,
          error: table === failTable ? { message: 'unavailable' } : null }).then(resolve);
      },
    };
    return q;
  } };
}
const response = () => ({
  headers: {}, statusCode: 200, setHeader(k, v) { this.headers[k] = v; },
  status(code) { this.statusCode = code; return this; }, end() { return this; },
  send(body) { this.body = body; return this; }, json(body) { this.body = body; return this; },
});
const request = path => ({ method: 'GET', url: path, query: { path },
  headers: { host: 'alpha.test' } });

test('tenant-scoped authority updates immediately, explicit clear defeats legacy fallback', async () => {
  const tables = fixture(), db = database(tables);
  assert.equal((await resolveHomepage(db, tenant)).slug, 'welcome-one');
  assert.equal((await resolveHomepage(db, { id: 'beta' })).slug, 'second-two');
  tables.system_settings[1].setting_value = '';
  assert.equal(await readHomepageSlug(db, 'beta'), '');
  tables.system_settings.pop();
  assert.equal(await readHomepageSlug(db, 'beta'), 'legacy');
  tables.system_settings[0].setting_value = '';
  assert.equal((await homepageRoute(db, tenant, '/welcome-one')).target, undefined);
});

test('invalid, private, draft, microsite and failed lookups never authorize redirect', async () => {
  for (const change of [{ status: 'draft' }, { layout_type: 'member' }, { microsite_id: 'm' }, { tenant_id: 'other' }]) {
    const tables = fixture();
    Object.assign(tables.i_edit_page[0], change);
    assert.equal((await resolveHomepage(database(tables), tenant)).state, 'invalid');
    assert.equal((await homepageRoute(database(tables), tenant, '/welcome-one')).target, undefined);
  }
  assert.equal((await resolveHomepage(database(fixture(), 'system_settings'), tenant)).state, 'error');
});

test('aliases, trailing slashes, query strings and fragments are one-way and uncached', async () => {
  const db = database(fixture());
  for (const path of ['/welcome-one', '/welcome-one/', '/Home', '/home/']) {
    const res = response();
    await createUnknownPageHttpPolicy({ database: db, resolveTenant: async () => tenant })(
      request(`${path}?campaign=a%26b#section`), res);
    assert.equal(res.statusCode, 308);
    assert.equal(res.headers.Location, '/?campaign=a%26b#section');
    assert.match(res.headers['Cache-Control'], /no-store/);
  }
  assert.equal((await homepageRoute(db, tenant, '/')).root, true);
  assert.equal((await homepageRoute(db, tenant, '/welcome-one?_canvasPreview=1')).target, undefined);
});

test('active microsites and registered routes retain precedence', async () => {
  const tables = fixture();
  tables.microsite = [{ tenant_id: 'alpha', id: 'micro', is_active: true, path_prefix: 'welcome-one' }];
  assert.equal((await homepageRoute(database(tables), tenant, '/welcome-one')).target, undefined);
  tables.i_edit_page[0].slug = tables.system_settings[0].setting_value = 'Dashboard';
  assert.equal((await homepageRoute(database(tables), tenant, '/Dashboard')).target, undefined);
  assert.equal((await homepageRoute(database(tables), tenant, '/assets/main.js')).target, undefined);
});

test('ordinary root HTML and crawlers share selected content, SEO, root canonical and tenant icon', async () => {
  const db = database(fixture());
  const res = response();
  await createPrerenderHandler({ database: db, resolveTenant: async () => tenant })(request('/?utm=abc'), res);
  assert.equal(res.statusCode, 200);
  const previousFetch = globalThis.fetch;
  // Ancillary typography/font/chrome discovery is unrelated to homepage data.
  globalThis.fetch = async () => new Response('[]', { headers: { 'content-type': 'application/json' } });
  let html;
  try { html = await renderTenantHtml(request('/'), {
    database: db, resolveTenant: async () => tenant,
    template: '<html><head><title>Platform</title><link rel="shortcut icon" href="/favicon.ico"></head><body><div id="root"></div></body></html>',
  }); } finally { globalThis.fetch = previousFetch; }
  for (const body of [res.body, html]) {
    assert.match(body, /Substantive guest homepage content/);
    assert.match(body, /Search title/);
    assert.match(body, /Search description/);
    assert.match(body, /rel="canonical" href="https:\/\/alpha.test\/"/);
    assert.match(body, /property="og:url" content="https:\/\/alpha.test\/"/);
    assert.match(body, /"url":"https:\/\/alpha.test\/"/);
    assert.match(body, /https:\/\/images.test\/alpha.svg/);
    assert.doesNotMatch(body, /favicon-32|favicon-192|shortcut icon/);
  }
});

test('crawler redirect and favicon discovery do not cache tenant-specific decisions', async () => {
  const res = response();
  await createPrerenderHandler({ database: database(fixture()), resolveTenant: async () => tenant })(request('/welcome-one?x=1'), res);
  assert.equal(res.statusCode, 308);
  assert.equal(res.headers.Location, '/?x=1');
  for (const resolved of [tenant, null, { favicon_url: 'javascript:alert(1)' }]) {
    const icon = response();
    await createFaviconHandler({ resolveTenant: async () => resolved })(request('/favicon.ico'), icon);
    assert.equal(icon.statusCode, 302);
    assert.equal(icon.headers.Location, resolved === tenant ? tenant.favicon_url : '/platform-icon.svg');
    assert.match(icon.headers['Cache-Control'], /no-store/);
  }
});

test('middleware intercepts ordinary root/static favicon and preserves crawler redirect cache policy', async () => {
  const saved = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async url => {
    seen.push(new URL(url).pathname);
    return new Response(null, { status: 308, headers: { location: '/', 'cache-control': 'private, no-store' } });
  };
  try {
    for (const [path, ua] of [['/', 'Mozilla'], ['/favicon.ico', 'Mozilla'], ['/welcome-one', 'Googlebot']]) {
      const result = await middleware(new Request(`https://alpha.test${path}`, { headers: { 'user-agent': ua } }));
      assert.equal(result.status, 308);
      assert.match(result.headers.get('cache-control'), /no-store/);
    }
    assert.deepEqual(seen, ['/api/render', '/api/public/favicon', '/api/public/prerender']);
  } finally { globalThis.fetch = saved; }
});

test('sitemap omits only current selected homepage and restores old slug after clearing', async () => {
  const tables = fixture();
  tables.i_edit_page.push({ ...tables.i_edit_page[0], id: 'other', slug: 'other-page' });
  const handler = createSitemapHandler({ database: database(tables), resolveTenant: async () => tenant });
  let res = response();
  await handler(request('/sitemap.xml'), res);
  assert.equal(res.statusCode, 200);
  assert.match(res.body, /<loc>https:\/\/alpha.test\/<\/loc>/);
  assert.match(res.body, /alpha.test\/other-page/);
  assert.doesNotMatch(res.body, /alpha.test\/welcome-one/);
  tables.system_settings[0].setting_value = '';
  res = response();
  await handler(request('/sitemap.xml'), res);
  assert.match(res.body, /alpha.test\/welcome-one/);
});

test('root reuses Canvas dynamic content with guest projection and legacy elements', async () => {
  for (const builder of ['canvas', 'legacy']) {
    const tables = fixture();
    Object.assign(tables.i_edit_page[0], { builder_type: builder, canvas_design: {
      root: { sections: [{ children: [
        { type: 'text', content: { html: '<p>Public Canvas welcome content</p>' } },
        { type: 'custom-html', content: { memberOnly: true, html: 'PRIVATE SECRET CONTENT' } },
        { type: 'article-list', content: {} },
        { type: 'dynamic-widget', content: { html: 'PRIVATE WIDGET CONTENT' } },
      ] }] },
    } });
    tables.blog_post = [
      { tenant_id: 'alpha', status: 'published', title: 'Published dynamic story', summary: 'Public dynamic summary' },
      { tenant_id: 'beta', status: 'published', title: 'OTHER TENANT SECRET' },
      { tenant_id: 'alpha', status: 'draft', title: 'DRAFT SECRET' },
    ];
    tables.i_edit_page_element = [{ page_id: 'welcome-one', content: { heading: 'Public legacy welcome content' } }];
    const res = response();
    await createPrerenderHandler({ database: database(tables), resolveTenant: async () => tenant })(request('/'), res);
    assert.equal(res.statusCode, 200);
    assert.doesNotMatch(res.body, /PRIVATE SECRET|PRIVATE WIDGET|OTHER TENANT SECRET|DRAFT SECRET/);
    if (builder === 'canvas') {
      assert.match(res.body, /Public Canvas welcome content/);
      assert.match(res.body, /Published dynamic story/);
    } else {
      assert.match(res.body, /Public legacy welcome content/);
    }
  }
});
