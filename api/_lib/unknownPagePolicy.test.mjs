import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { matchesRegisteredRoute } from '../../shared/registeredRoutes.js';
import { MEMBERSHIP_RETURN_ROUTES } from '../../client/src/lib/membershipPaymentReturn.js';
import { resolveUnknownPagePolicy, safeRedirectTarget } from './unknownPagePolicy.js';

const tenant = { id: 'a', settings: { redirect_unknown_pages_to_homepage: true } };
function database(tables = {}, failTable) {
  tables = { tenant: [{ ...tenant, status: 'active' }], ...tables };
  const calls = [];
  return {
    calls,
    from(table) {
      const filters = [];
      const query = {
        select() { return query; },
        eq(key, value) { filters.push([key, value]); return query; },
        is(key, value) { filters.push([key, value]); return query; },
        in(key, value) { filters.push([key, value]); return query; },
        order() { return query; },
        then(resolve) {
          calls.push({ table, filters });
          return Promise.resolve({
            data: (tables[table] || []).filter(row => filters.every(([key, value]) =>
              Array.isArray(value) ? value.includes(row[key]) : (row[key] ?? null) === value)),
            error: table === failTable ? { message: 'database failed' } : null,
          }).then(resolve);
        },
      };
      return query;
    },
  };
}
const rule = (extra = {}) => ({ tenant_id: 'a', is_active: true, source_pattern: '/', match_type: 'prefix', target_url: '/Home', status_code: 301, ...extra });

test('every literal registered route is covered; dynamic CMS routes are not', () => {
  const source = readFileSync(new URL('../../client/src/pages/index.jsx', import.meta.url), 'utf8');
  const dynamic = ['/:slug', '/:micrositePrefix/search', '/:micrositePrefix/Search', '/:micrositePrefix/:slug', '/*', '*'];
  for (const [, path] of source.matchAll(/<Route path="([^"]+)"/g)) {
    if (!dynamic.includes(path)) assert.ok(matchesRegisteredRoute(path.replace(/:[^/]+/g, 'example')), path);
  }
  for (const route of MEMBERSHIP_RETURN_ROUTES) assert.ok(matchesRegisteredRoute(route.path));
  assert.equal(matchesRegisteredRoute('/some-unknown-page'), false);
  assert.equal(matchesRegisteredRoute('/some-prefix/some-page'), false);
});

test('deployed Vercel rewrite ordering sends legacy pages to HTML for browsers and crawlers', () => {
  const config = JSON.parse(readFileSync(new URL('../../vercel.json', import.meta.url), 'utf8'));
  // Evaluate the actual ordered deployment rules, not a duplicate route list.
  function destination(path, userAgent) {
    const matchesConditions = rule => {
      const conditionMatches = condition => {
        assert.equal(condition.type, 'header', 'extend this evaluator for new deployment conditions');
        assert.equal(condition.key.toLowerCase(), 'user-agent');
        return new RegExp(condition.value).test(userAgent);
      };
      return (rule.has || []).every(conditionMatches)
        && !(rule.missing || []).some(conditionMatches);
    };
    for (const rule of config.rewrites) {
      const expression = new RegExp(`^${rule.source}$`);
      if (expression.test(path) && matchesConditions(rule)) {
        return path.replace(expression, rule.destination);
      }
    }
    return null;
  }
  for (const agent of ['Mozilla/5.0', 'Googlebot/2.1', 'bingbot/2.0', 'facebookexternalhit/1.1']) {
    for (const path of ['/old.html', '/old.aspx', '/old.php', '/legacy/old.html', '/old.HTML', '/missing']) {
      assert.equal(destination(path, agent), '/api/render', `${agent}: ${path}`);
    }
    for (const path of ['/assets/main.js', '/main.css', '/font.woff2', '/image.png', '/site.webmanifest', '/library.wasm']) {
      assert.equal(destination(path, agent), path, `${agent}: static ${path}`);
    }
    assert.equal(destination('/robots.txt', agent), '/api/public/robots.txt');
    assert.equal(destination('/sitemap.xml', agent), '/api/public/sitemap.xml');
    assert.equal(destination('/api/redirects/resolve', agent), null);
    assert.equal(destination('/api/example.json', agent), null);
  }
});

test('missing default-off, default-on and exact mapping precedence', async () => {
  assert.deepEqual(await resolveUnknownPagePolicy(database({ tenant: [{ id: 'a', status: 'active', settings: {} }] }), tenant, '/gone'), { found: false, route_outcome: 'missing' });
  assert.deepEqual(await resolveUnknownPagePolicy(database(), tenant, '/gone?x=1'), { found: true, route_outcome: 'missing', target_url: '/', status_code: 302 });
  const db = database({ redirect_mapping: [rule({ source_pattern: '/gone', match_type: 'exact' })] });
  assert.equal((await resolveUnknownPagePolicy(db, tenant, '/gone')).target_url, '/Home');
  assert.ok(db.calls.every(call => call.filters.some(([key, value]) => key === (call.table === 'tenant' ? 'id' : 'tenant_id') && value === 'a')));
});

test('registered, asset, root and callback paths never consult rules', async () => {
  for (const path of ['/', '/Dashboard', '/events/example', '/membership/monthly-card/complete', '/api/test', '/assets/missing.js', '/auth/callback']) {
    const db = database({}, 'redirect_mapping');
    assert.equal((await resolveUnknownPagePolicy(db, tenant, path)).found, false);
    assert.equal(db.calls.length, 0);
  }
});

test('pages and active restricted forms precede broad rules', async () => {
  for (const fields of [{}, { require_authentication: true }, { access_policy: { restricted: true } }, { form_type: 'survey' }]) {
    const db = database({ form: [{ tenant_id: 'a', slug: 'join', is_active: true, ...fields }], redirect_mapping: [rule()] });
    assert.equal((await resolveUnknownPagePolicy(db, tenant, '/join')).found, false);
    assert.ok(!db.calls.some(call => call.table === 'redirect_mapping'));
  }
  for (const status of ['draft', 'published']) {
    const db = database({ i_edit_page: [{ tenant_id: 'a', slug: 'page', status, microsite_id: null }], redirect_mapping: [rule()] });
    assert.equal((await resolveUnknownPagePolicy(db, tenant, '/page')).found, false);
  }
});

test('other tenant forms and mappings cannot affect this tenant', async () => {
  const db = database({ form: [{ tenant_id: 'b', slug: 'join', is_active: true }], redirect_mapping: [rule({ tenant_id: 'b' })] });
  assert.equal((await resolveUnknownPagePolicy(db, tenant, '/join')).target_url, '/');
});

test('all data failures fail closed', async () => {
  for (const table of ['system_settings', 'microsite', 'i_edit_page', 'form', 'redirect_mapping', 'tenant']) {
    await assert.rejects(resolveUnknownPagePolicy(database({}, table), tenant, '/gone'), /lookup failed/);
  }
});

test('unsafe targets, direct and chained loops fail closed', async () => {
  for (const target of ['javascript:alert(1)', '//evil.test', '/gone', '/\\evil.test', '/x\r\nLocation: evil']) {
    assert.equal(safeRedirectTarget(target, '/gone'), null);
  }
  await assert.rejects(resolveUnknownPagePolicy(database({ redirect_mapping: [
    rule({ source_pattern: '/a', match_type: 'exact', target_url: '/b' }),
    rule({ source_pattern: '/b', match_type: 'exact', target_url: '/a' }),
  ] }), tenant, '/a'), /loop/);
});

test('custom terminology and microsite pages survive fallback', async () => {
  const db = database({
    system_settings: [{ tenant_id: 'a', setting_key: 'article_display_name', setting_value: 'Ideas' }, { tenant_id: 'a', setting_key: 'member_display_name', setting_value: '{"plural":"Associates"}' }],
    microsite: [{ tenant_id: 'a', id: 'micro', path_prefix: 'branch', is_active: true }],
    i_edit_page: [{ tenant_id: 'a', slug: 'welcome', microsite_id: 'micro', status: 'published' }],
  });
  for (const path of ['/ideas', '/ideasview', '/ideas/author/story', '/associates/123', '/branch', '/branch/welcome', '/branch/search']) {
    assert.equal((await resolveUnknownPagePolicy(db, tenant, path)).found, false, path);
  }
});