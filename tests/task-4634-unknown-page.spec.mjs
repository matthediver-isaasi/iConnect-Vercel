import { test, expect } from '@playwright/test';
import { build } from 'esbuild';
import path from 'node:path';
import fs from 'node:fs';
import { BUILTIN_ARTICLE_ALIASES } from '../shared/articleAliases.js';

// Actual routing components, in-memory providers, and a deny-all network boundary.
// No app server, tenant records, sessions, or provider credentials are used.
let script;
// Read the real static route declarations rather than maintaining another
// built-in route list. Leaf renderers are intentionally out of this harness.
const routeSource = fs.readFileSync('client/src/pages/index.jsx', 'utf8');
const builtInPaths = [...new Set([...routeSource.matchAll(/<Route\s+path="([^"]+)"/g)]
  .map(match => match[1])
  .filter(route => !['/', '*', '/*', '/:slug', '/:micrositePrefix/:slug'].includes(route)))];
const articlePaths = BUILTIN_ARTICLE_ALIASES.flatMap(alias => [
  `/${alias}/author/:authorHandle`, `/${alias}/:authorHandle/:articleSlug`,
]);
const declaredPaths = [...builtInPaths, ...articlePaths];
const stubs = {
  '@/api/publicClient': `
    export const getTenantSlugFromLocation = () => 'fixture-tenant';
    export const publicClient = {
      getPage: async (slug, prefix) => {
        window.fixture.pageCalls.push({ slug, prefix });
        if (window.fixture.pagePending) return new Promise(() => {});
        if (window.fixture.pageError) throw new Error('Page lookup unavailable');
        return { page: window.fixture.cmsPage || null };
      },
      getForm: async () => {
        window.fixture.formCalls++;
        if (window.fixture.formPending) return new Promise(() => {});
        if (window.fixture.formError) throw new Error('Form unavailable');
        if (window.fixture.restricted) throw { status: 403, errorData: { access: { allowed: false } } };
        if (window.fixture.form) return { id: 'fixture-form' };
        throw { status: 404 };
      },
    };`,
  '@/api/base44Client': `export const base44 = { entities: { IEditPage: { list: async () => [] } } };`,
  '@/hooks/useMemberAccess': `export const useMemberAccess = () => ({
    authResolved: !window.fixture.authPending, sessionValidated: false, memberInfo: null,
    isAccessReady: true, isFeatureExcluded: () => false,
  });`,
  '@/contexts/LayoutContext': `export const usePageLayoutDecision = () => {};
    const noop = () => {};
    export const useLayoutContext = () => ({ setForcePublicLayout: noop, setChromeReady: noop });`,
  '@/contexts/TenantBrandingContext': `export const useTenantBranding = () => ({
    branding: { id: 'fixture-tenant' }, loading: false, error: null,
  });`,
  '@/contexts/MicrositeContext': `export const useMicrosite = () => ({
    microsites: window.fixture.microsites || [], micrositesLoaded: !window.fixture.micrositesPending,
    micrositesError: window.fixture.micrositesError ? new Error('Microsites unavailable') : null,
    activeMicrosite: window.fixture.activeMicrosite || null,
  });`,
  '@/contexts/ArticleUrlContext': `export const useArticleUrl = () => ({ isLoading: false, isCustomSlug: false });`,
  '@/contexts/BannerContext': `export const useBelowFirstElementBanners = () => [];`,
  './FormView': `export default function FormView() {
    return <div data-testid="fixture-form">{window.fixture.restricted ? 'Sign in required' : 'Real form route'}</div>;
  }`,
  '@/components/ErrorBoundary': `export default function Boundary({ children }) { return children; }`,
  '../components/canvas/CanvasPageRenderer': `export default function Canvas() { return <div>Published microsite content</div>; }`,
};

test.beforeAll(async () => {
  const result = await build({
    stdin: {
      contents: `
        import React from 'react';
        import { createRoot } from 'react-dom/client';
        import { BrowserRouter, Routes, Route } from 'react-router-dom';
        import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
        import DynamicPage from './client/src/pages/DynamicPage.jsx';
        import CatchAllNotFound from './client/src/pages/CatchAllNotFound.jsx';
        createRoot(document.getElementById('root')).render(
          <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
            <BrowserRouter><Routes>
              <Route path="/" element={<div data-testid="home">Home</div>} />
              <Route path="/mapped" element={<div data-testid="mapped">Mapped</div>} />
              {${JSON.stringify(declaredPaths)}.map(path => <Route key={path} path={path}
                element={<div data-testid="declared-route">{path}</div>} />)}
              <Route path="/:slug" element={<DynamicPage />} />
              <Route path="/:micrositePrefix/:slug" element={<DynamicPage />} />
              <Route path="*" element={<CatchAllNotFound />} />
            </Routes></BrowserRouter>
          </QueryClientProvider>);
      `,
      resolveDir: process.cwd(),
      loader: 'jsx',
    },
    bundle: true, write: false, jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"test"' },
    plugins: [{
      name: 'isolated-routing',
      setup(api) {
        api.onResolve({ filter: /.*/ }, args => {
          if (stubs[args.path]) return { path: args.path, namespace: 'stub' };
          if ((args.path.startsWith('../components/') || args.path.startsWith('@/components/')) ||
              ['./Articles', './ArticleView', './ArticleEditor', './PublicArticles'].includes(args.path)) {
            return { path: 'empty', namespace: 'stub' };
          }
          if (args.path.startsWith('@/')) {
            const base = path.resolve('client/src', args.path.slice(2));
            const file = [base, `${base}.js`, `${base}.jsx`].find(candidate => fs.existsSync(candidate));
            return { path: file };
          }
        });
        api.onLoad({ filter: /.*/, namespace: 'stub' }, args => ({
          contents: stubs[args.path] || 'export default function Empty() { return null; }',
          loader: 'jsx', resolveDir: process.cwd(),
        }));
      },
    }],
  });
  script = result.outputFiles[0].text;
});

async function mount(page, pathname, fixture = {}, resolution = { found: true, target_url: '/', route_outcome: 'missing' }) {
  const requests = [];
  const unexpected = [];
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.hostname === 'routing.invalid' && url.pathname === '/api/redirects/resolve') {
      requests.push(url);
      if (fixture.resolverPending) return;
      return route.fulfill({ status: fixture.resolverError ? 503 : 200,
        contentType: 'application/json', body: JSON.stringify(resolution) });
    }
    if (route.request().isNavigationRequest() && url.hostname === 'routing.invalid') {
      return route.fulfill({ contentType: 'text/html', body: '<div id="root"></div>' });
    }
    unexpected.push(route.request().url());
    return route.abort();
  });
  await page.goto(`http://routing.invalid${pathname}`);
  await page.evaluate(fixture => { window.fixture = { formCalls: 0, pageCalls: [], ...fixture }; }, fixture);
  await page.addScriptTag({ content: script });
  return { requests, unexpected };
}

for (const pathname of ['/missing', '/unknown-prefix/missing', '/deep/unknown/path']) {
  test(`confirmed miss redirects with replace: ${pathname}`, async ({ page }) => {
    const { requests, unexpected } = await mount(page, pathname);
    await expect(page.getByTestId('home')).toBeVisible();
    expect(requests).toHaveLength(1);
    expect(requests[0].searchParams.get('path')).toBe(pathname);
    expect(requests[0].searchParams.get('tenant')).toBe('fixture-tenant');
    await page.goBack();
    expect(new URL(page.url()).pathname).not.toBe(pathname);
    expect(unexpected).toEqual([]);
  });
}

for (const fixture of [{ form: true }, { restricted: true }]) {
  test(`pretty form takes precedence: ${JSON.stringify(fixture)}`, async ({ page }) => {
    const { requests } = await mount(page, '/application', fixture);
    await expect(page.getByTestId('fixture-form')).toBeVisible();
    expect(requests).toHaveLength(0);
    expect(new URL(page.url()).pathname).toBe('/application');
  });
}

for (const fixture of [{ pageError: true }, { formError: true }, { micrositesError: true }]) {
  test(`lookup error never redirects: ${JSON.stringify(fixture)}`, async ({ page }) => {
    const { requests } = await mount(page, '/missing', fixture);
    await expect(page.getByRole('alert')).toContainText('Page unavailable');
    expect(requests).toHaveLength(0);
  });
}

for (const fixture of [{ pagePending: true }, { formPending: true }, { authPending: true }, { micrositesPending: true }]) {
  test(`pending never redirects: ${JSON.stringify(fixture)}`, async ({ page }) => {
    const { requests } = await mount(page, '/missing', fixture);
    await expect(page.locator('[aria-busy="true"]')).toBeVisible();
    await page.waitForTimeout(100);
    expect(requests).toHaveLength(0);
  });
}

test('explicit rule wins over homepage and strips source query/hash', async ({ page }) => {
  await mount(page, '/old?private=value#fragment', {}, { found: true, target_url: '/mapped', route_outcome: 'missing' });
  await expect(page.getByTestId('mapped')).toBeVisible();
  expect(new URL(page.url()).search).toBe('');
  expect(new URL(page.url()).hash).toBe('');
});

for (const pathname of ['/missing', '/deep/unknown/path']) {
  test(`resolver failure remains visible: ${pathname}`, async ({ page }) => {
    await mount(page, pathname, { resolverError: true });
    await expect(page.getByRole('alert')).toContainText('Page unavailable');
    expect(new URL(page.url()).pathname).toBe(pathname);
  });
  test(`disabled setting retains not found: ${pathname}`, async ({ page }) => {
    await mount(page, pathname, {}, { found: false, route_outcome: 'missing' });
    await expect(page.getByTestId('page-not-found')).toBeVisible();
  });
}

test('server restricted outcome never redirects', async ({ page }) => {
  await mount(page, '/deep/unknown/path', {}, { found: false, route_outcome: 'restricted' });
  await expect(page.getByTestId('page-not-found')).toBeVisible();
  expect(new URL(page.url()).pathname).toBe('/deep/unknown/path');
});

for (const cmsPage of [
  { id: 'draft', status: 'draft', layout_type: 'public' },
  { id: 'member', status: 'published', layout_type: 'member' },
]) {
  test(`existing CMS ${cmsPage.id} never enters fallback`, async ({ page }) => {
    const { requests } = await mount(page, '/real-page', { cmsPage });
    await expect(page.getByTestId(cmsPage.id === 'draft' ? 'page-not-published' : 'page-requires-login')).toBeVisible();
    expect(requests).toHaveLength(0);
    expect(await page.evaluate(() => window.fixture.formCalls)).toBe(0);
  });
}

for (const target of ['/missing', 'javascript:alert(1)', 'http://[invalid']) {
  test(`invalid/self target never navigates: ${target}`, async ({ page }) => {
    await mount(page, '/missing', {}, { found: true, target_url: target, route_outcome: 'missing' });
    await expect(page.getByTestId('page-not-found')).toBeVisible();
    expect(new URL(page.url()).pathname).toBe('/missing');
  });
}

test('catch-all pending resolver never navigates', async ({ page }) => {
  await mount(page, '/deep/unknown/path', { resolverPending: true });
  await expect(page.getByTestId('page-checking-redirect')).toBeVisible();
  expect(new URL(page.url()).pathname).toBe('/deep/unknown/path');
});

for (const pathname of ['/Events', '/Dashboard', '/events/fixture-event', '/articles/fixture-author/fixture-story', '/blogs/author/fixture-author']) {
  test(`registered route parity avoids fallback: ${pathname}`, async ({ page }) => {
    const { requests } = await mount(page, pathname);
    await expect(page.getByTestId('declared-route')).toBeVisible();
    expect(requests).toHaveLength(0);
    expect(await page.evaluate(() => window.fixture.pageCalls)).toEqual([]);
    expect(await page.evaluate(() => window.fixture.formCalls)).toBe(0);
  });
}

for (const home of [false, true]) {
  test(`microsite valid ${home ? 'home' : 'page'} stays in scope`, async ({ page }) => {
    const microsite = { id: 'fixture-microsite', path_prefix: 'conference', home_slug: 'welcome' };
    const pathname = home ? '/conference' : '/conference/programme';
    const { requests } = await mount(page, pathname, {
      microsites: [microsite], activeMicrosite: microsite,
      cmsPage: { id: 'fixture-page', status: 'published', builder_type: 'canvas', layout_type: 'public' },
    });
    await expect(page.getByTestId(`dynamic-page-${home ? 'conference' : 'programme'}`)).toBeVisible();
    expect(requests).toHaveLength(0);
    expect(await page.evaluate(() => window.fixture.pageCalls)).toEqual([
      { slug: home ? 'welcome' : 'programme', prefix: 'conference' },
    ]);
  });
}

test('isolated not-found screenshot', async ({ page }) => {
  await mount(page, '/deep/unknown/path', {}, { found: false, route_outcome: 'missing' });
  await expect(page.getByTestId('page-not-found')).toBeVisible();
  fs.mkdirSync('screenshots', { recursive: true });
  await page.screenshot({ path: 'screenshots/task-4634-isolated-not-found.png', fullPage: true });
});