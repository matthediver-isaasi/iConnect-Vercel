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
        import ResourceCard from "./client/src/components/resources/ResourceCard.jsx";
        const client = new QueryClient({defaultOptions:{queries:{retry:false}}});
        const root = createRoot(document.getElementById("root"));
        function App(){const nav=useNavigate();window.go=nav;return window.fixture.mode==="card"
          ? <ResourceCard resource={window.fixture.resource}
              isAuthenticated={window.fixture.authenticated!==false}
              isLocked={!!window.fixture.locked}
              openInNewTab={window.fixture.openInNewTab}
              onResourceView={id=>window.fixture.tracked.push(id)}/>
          : <Resources/>;}
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

async function mount(page, {
  resolved = true, validated = true, guest = false, denied = false,
  resourceId = id, mode = 'single', resource, openInNewTab, locked = false,
} = {}) {
  const requests = [];
  const navigations = [];
  const fixtureResource = resource || {
    id, title: 'Requested resource', status: 'active', is_public: false,
    target_url: '/protected-target',
  };
  await page.context().route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.hostname === 'receiver.fixture.test') {
      navigations.push({
        url: url.href,
        headers: await route.request().allHeaders(),
      });
      return route.fulfill({
        contentType: 'text/html',
        body: '<!doctype html><title>External destination</title><h1>External destination</h1>',
      });
    }
    if (url.pathname.startsWith('/api/')) {
      requests.push(url.pathname);
      let body = {};
      let status = 200;
      if (url.pathname.includes('/resource/') || url.pathname.includes('/single/')) {
        status = denied || !url.pathname.endsWith(id) ? 404 : 200;
        body = status === 200 ? fixtureResource : { error: 'Unavailable' };
      } else if (url.pathname.endsWith('/categories')) body = [];
      else if (url.pathname.endsWith('/visible-categories')) body = { categories: [], hiddenSubcategories: [] };
      else if (url.pathname.endsWith('/view-counts')) body = { counts: {} };
      await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    } else await route.fulfill({ contentType: 'text/html', body: '<html><body><div id="root"></div></body></html>' });
  });
  const query = mode === 'single' ? `?resourceId=${resourceId}&search=retained` : '';
  await page.goto(`https://resources.test/resources${query}`);
  await page.evaluate(({ resolved, validated, guest, mode, resource, openInNewTab, locked }) => {
    const f = window.fixture = {
      resolved, validated, member: guest ? null : { id: 'member', tenant_id: 'tenant' }, calls: [],
      tracked: [], writes: [], mode, resource, openInNewTab, locked,
      authenticated: !guest,
    };
    const entity = name => ({
      list: async () => { f.calls.push(`${name}.list`); return []; },
      listAll: async () => {
        f.calls.push(`${name}.listAll`);
        return name === 'Resource' && f.resource ? [f.resource] : [];
      },
      filter: async () => [],
      create: async data => { f.writes.push({ name, data }); return data; },
    });
    f.api = { entities: new Proxy({}, { get: (_, name) => entity(name) }), auth: { me: async () => ({}) } };
    f.publicApi = { getTenantSlug: () => 'tenant', listResources: async () => [], listResourceCategories: async () => [], getResourceAuthorSettings: async () => ({}) };
  }, { resolved, validated, guest, mode, resource: fixtureResource, openInNewTab, locked });
  await page.addScriptTag({ content: script });
  Object.defineProperty(requests, 'navigations', { value: navigations });
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

const externalTarget = 'https://receiver.fixture.test/landing/private-path?resource=secret';
const externalResource = (openInNewTab) => ({
  id,
  title: 'Cross-origin resource',
  description: 'Navigation policy fixture',
  status: 'active',
  is_public: true,
  resource_type: 'external_link',
  target_url: externalTarget,
  open_in_new_tab: openInNewTab,
});

async function clickExternal(page, requests, opensNewTab) {
  await expect(page.getByRole('button', { name: 'Visit Site' })).toBeVisible();
  if (opensNewTab) {
    const popupPromise = page.context().waitForEvent('page');
    await page.getByRole('button', { name: 'Visit Site' }).click();
    const popup = await popupPromise;
    await popup.waitForLoadState();
    await expect(popup.getByRole('heading', { name: 'External destination' })).toBeVisible();
    expect(await popup.evaluate(() => window.opener === null)).toBe(true);
  } else {
    await page.getByRole('button', { name: 'Visit Site' }).click();
    await expect(page.getByRole('heading', { name: 'External destination' })).toBeVisible();
    await expect(page).toHaveURL(externalTarget);
  }
  await expect.poll(() => requests.navigations.length).toBe(1);
  const navigation = requests.navigations[0];
  expect(navigation.url).toBe(externalTarget);
  expect(navigation.headers.referer).toBe('https://resources.test/');
  const referer = new URL(navigation.headers.referer);
  expect(referer.pathname).toBe('/');
  expect(referer.search).toBe('');
}

for (const mode of ['library', 'single']) {
  for (const opensNewTab of [true, false]) {
    test(`${mode} external link uses stored ${opensNewTab ? 'new' : 'same'} tab choice with origin-only Referer`, async ({ page }) => {
      const requests = await mount(page, {
        mode,
        resource: externalResource(opensNewTab),
      });
      await clickExternal(page, requests, opensNewTab);
    });
  }
}

test('library external navigation records the view before opening a noopener tab', async ({ page }) => {
  const requests = await mount(page, {
    mode: 'library',
    resource: externalResource(true),
  });
  await clickExternal(page, requests, true);
  await expect.poll(() => page.evaluate(() => window.fixture.writes)).toEqual([{
    name: 'ResourceView',
    data: expect.objectContaining({
      resource_id: id,
      user_identifier: 'member',
      is_member: true,
    }),
  }]);
});

for (const override of [true, false]) {
  test(`explicit card override forces ${override ? 'new' : 'same'} tab over stored preference`, async ({ page }) => {
    const requests = await mount(page, {
      mode: 'card',
      resource: externalResource(!override),
      openInNewTab: override,
    });
    await clickExternal(page, requests, override);
  });
}

test('protected card gates external target without issuing a navigation request', async ({ page }) => {
  const requests = await mount(page, {
    mode: 'card',
    guest: true,
    locked: true,
    resource: { ...externalResource(true), is_public: false },
  });
  await expect(page.getByRole('button', { name: 'Member only content - click to login' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Visit Site' })).toHaveCount(0);
  expect(requests.navigations).toEqual([]);
  expect(await page.evaluate(() => window.fixture.tracked)).toEqual([]);
});

test('video remains an in-page dialog and is tracked without external navigation', async ({ page }) => {
  const requests = await mount(page, {
    mode: 'card',
    resource: {
      id,
      title: 'Video resource',
      status: 'active',
      is_public: true,
      resource_type: 'video',
      target_url: '<iframe src="https://www.youtube.com/embed/dQw4w9WgXcQ"></iframe>',
      open_in_new_tab: true,
    },
  });
  await page.getByRole('button', { name: 'Watch Video' }).click();
  await expect(page.getByTestId(`dialog-resource-video-${id}`)).toBeVisible();
  await expect(page.getByTestId(`iframe-resource-video-${id}`))
    .toHaveAttribute('src', 'https://www.youtube.com/embed/dQw4w9WgXcQ');
  expect(requests.navigations).toEqual([]);
  expect(await page.evaluate(() => window.fixture.tracked)).toEqual([id]);
});
