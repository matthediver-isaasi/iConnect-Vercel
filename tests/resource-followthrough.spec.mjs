// Isolated browser harness: actual Resources router and detail query, with
// transport/auth/bookmark boundaries mocked. No application or live API is used.
import { test, expect } from '@playwright/test';
import { build } from 'esbuild';
import path from 'node:path';

const id = '11111111-1111-4111-8111-111111111111';
let script;
test.beforeAll(async () => {
  const mocks = {
    '@/api/base44Client': `export const base44 = window.fixture.api;`,
    '@/api/publicClient': `export const publicClient = window.fixture.publicApi;`,
    '@/hooks/useMemberAccess': `export const useMemberAccess = () => ({
      memberInfo:window.fixture.member, memberRole:{id:"role"}, isAdmin:false, isFeatureExcluded:()=>false
    });`,
    '@/contexts/LayoutContext': `export const useLayoutContext = () => ({
      authResolved:window.fixture.resolved, sessionValidated:window.fixture.validated, hasBanner:false
    });`,
    '@/contexts/TenantBrandingContext': `export const useTenantBranding = () => ({});`,
    '@/hooks/useResourceRealtime': `export const useResourceRealtime = () => {};`,
    '../bookmarks/BookmarkButton': `export default () => null;`,
  };
  const result = await build({
    stdin: {
      contents: `import React from "react"; import {createRoot} from "react-dom/client";
        import {QueryClient,QueryClientProvider} from "@tanstack/react-query";
        import {BrowserRouter,useNavigate} from "react-router-dom";
        import Resources from "./client/src/pages/Resources.jsx";
        const client = new QueryClient({defaultOptions:{queries:{retry:false}}});
        const root = createRoot(document.getElementById("root"));
        function App(){const nav=useNavigate();window.go=nav;return <Resources/>;}
        window.redraw = () => root.render(<QueryClientProvider client={client}>
          <BrowserRouter><App key={window.fixture.revision||0}/></BrowserRouter></QueryClientProvider>);
        window.redraw();`,
      resolveDir: process.cwd(), loader: 'jsx',
    },
    bundle: true, write: false, jsx: 'automatic',
    alias: { '@': path.resolve('client/src') },
    define: { 'process.env.NODE_ENV': '"test"' },
    plugins: [{
      name: 'isolated-boundaries',
      setup(b) {
        b.onResolve({ filter: /.*/ }, args => args.path in mocks ? { path: args.path, namespace: 'fixture' } : null);
        b.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ contents: mocks[args.path], loader: 'jsx', resolveDir: process.cwd() }));
      },
    }],
  });
  script = result.outputFiles[0].text;
});

async function mount(page, { resolved = true, validated = true, guest = false, denied = false, resourceId = id } = {}) {
  const requests = [];
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.pathname.startsWith('/api/')) {
      requests.push(url.pathname);
      let body = {};
      let status = 200;
      if (url.pathname.includes('/resource/') || url.pathname.includes('/single/')) {
        status = denied || !url.pathname.endsWith(id) ? 404 : 200;
        body = status === 200 ? { id, title: 'Requested resource', status: 'active', is_public: false, target_url: '/protected-target' } : { error: 'Unavailable' };
      } else if (url.pathname.endsWith('/categories')) body = [];
      else if (url.pathname.endsWith('/visible-categories')) body = { categories: [], hiddenSubcategories: [] };
      else if (url.pathname.endsWith('/view-counts')) body = { counts: {} };
      await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    } else await route.fulfill({ contentType: 'text/html', body: '<html><body><div id="root"></div></body></html>' });
  });
  await page.goto(`https://resources.test/resources?resourceId=${resourceId}&search=retained`);
  await page.evaluate(({ resolved, validated, guest }) => {
    const f = window.fixture = {
      resolved, validated, member: guest ? null : { id: 'member', tenant_id: 'tenant' }, calls: [],
    };
    const entity = name => ({
      list: async () => { f.calls.push(`${name}.list`); return []; },
      listAll: async () => { f.calls.push(`${name}.listAll`); return []; },
      filter: async () => [],
    });
    f.api = { entities: new Proxy({}, { get: (_, name) => entity(name) }), auth: { me: async () => ({}) } };
    f.publicApi = { getTenantSlug: () => 'tenant', listResources: async () => [], listResourceCategories: async () => [], getResourceAuthorSettings: async () => ({}) };
  }, { resolved, validated, guest });
  await page.addScriptTag({ content: script });
  return requests;
}

test('login return waits for validation, reads one, browses library only on demand', async ({ page }) => {
  const requests = await mount(page, { resolved: false, validated: false });
  await expect(page.getByRole('status')).toHaveText('Loading resource…');
  expect(requests).toEqual([]);
  await page.evaluate(() => {
    Object.assign(window.fixture, { resolved: true, validated: true, revision: 1 });
    window.redraw();
  });
  await expect(page.getByText('Requested resource', { exact: true })).toBeVisible();
  expect(requests).toEqual([`/api/resources/single/${id}`]);
  expect(await page.evaluate(() => window.fixture.calls)).toEqual([]);
  await page.getByRole('button', { name: 'View all resources' }).click();
  await expect(page).toHaveURL(/resources\?search=retained$/);
  await expect.poll(() => page.evaluate(() => window.fixture.calls)).toContain('Resource.listAll');
  await expect.poll(() => page.evaluate(() => window.fixture.calls)).toContain('MemberGroup.list');
});

for (const resourceId of [id, '', 'malformed']) {
  test(`unavailable ID ${resourceId || '(empty)'} never falls back to full library`, async ({ page }) => {
    const requests = await mount(page, { denied: true, resourceId });
    await expect(page.getByRole('alert')).toContainText('unavailable');
    expect(requests).toHaveLength(1);
    expect(await page.evaluate(() => window.fixture.calls)).toEqual([]);
    await expect(page.getByRole('button', { name: 'View all resources' })).toBeVisible();
  });
}
test('guest uses public single projection and retains specific login destination', async ({ page }) => {
  const requests = await mount(page, { guest: true, validated: false });
  await expect(page.getByRole('button', { name: 'Member only content - click to login' })).toBeVisible();
  expect(requests).toEqual([`/api/public/resource/${id}`]);
  expect(await page.evaluate(() => window.fixture.calls)).toEqual([]);
  await page.getByRole('button', { name: 'Member only content - click to login' }).click();
  await expect(page).toHaveURL(url => url.pathname.toLowerCase() === '/login'
    && url.searchParams.get('returnTo').toLowerCase() === '/resources'
    && url.searchParams.get('resourceId') === id);
});
test('switching IDs and logout do not retain protected resource content', async ({ page }) => {
  const requests = await mount(page);
  await expect(page.getByRole('button', { name: 'View Resource', exact: true })).toBeVisible();
  await page.evaluate(() => window.go('/resources?resourceId=missing'));
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(page.getByRole('button', { name: 'View Resource', exact: true })).toHaveCount(0);
  await page.evaluate(id => {
    window.fixture.member = null; window.fixture.validated = false;
    window.fixture.revision = 1; window.redraw(); window.go(`/resources?resourceId=${id}`);
  }, id);
  await expect(page.getByRole('button', { name: 'Member only content - click to login' })).toBeVisible();
  expect(requests).toContain(`/api/public/resource/${id}`);
  expect(await page.evaluate(() => window.fixture.calls)).toEqual([]);
});