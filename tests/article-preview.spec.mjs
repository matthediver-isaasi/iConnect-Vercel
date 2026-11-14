import { test, expect } from '@playwright/test';
import { build } from 'esbuild';
import path from 'node:path';

let script;
test.beforeAll(async () => {
  const mocks = {
    '@/contexts/TenantBrandingContext': `export const useTenantBranding=()=>({branding:{id:'tenant'},tenantSlug:'fixture'});`,
    '@/contexts/ArticleUrlContext': `export const useArticleUrl=()=>({displayName:'Articles'});`,
    '@/api/publicClient': `export const getTenantSlugFromLocation=()=> 'fixture';`,
  };
  const result = await build({
    stdin: { contents: `
      import React from 'react'; import {createRoot} from 'react-dom/client';
      import {BrowserRouter,Routes,Route,useNavigate} from 'react-router-dom';
      import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
      import ArticlePreview from './client/src/pages/ArticlePreview.jsx';
      import {installViewerProtectedWorkGate} from './client/src/lib/viewerProtectedWorkGate.js';
      window.rejections=0; window.clears=0;
      const client=new QueryClient(); const clear=client.clear.bind(client);
      client.clear=()=>{window.clears++;clear();};
      window.addEventListener('viewer-session-rejected',()=>{window.rejections++;client.clear();});
      installViewerProtectedWorkGate(window);
      function Shell(){const navigate=useNavigate();window.navigate=navigate;return <>
        <header>Guest header</header><Routes><Route path="/article-preview/:id" element={<ArticlePreview/>}/></Routes><footer>Guest footer</footer>
      </>}
      createRoot(document.getElementById('root')).render(<QueryClientProvider client={client}><BrowserRouter><Shell/></BrowserRouter></QueryClientProvider>);`,
      resolveDir: process.cwd(), loader: 'jsx' },
    bundle: true, write: false, jsx: 'automatic', alias: { '@': path.resolve('client/src') },
    define: { 'process.env.NODE_ENV': '"test"' },
    plugins: [{ name: 'fixture', setup(b) {
      b.onResolve({ filter: /.*/ }, args => mocks[args.path] ? { path: args.path, namespace: 'mock' } : null);
      b.onLoad({ filter: /.*/, namespace: 'mock' }, args => ({ contents: mocks[args.path], loader: 'jsx' }));
    } }],
  });
  script = result.outputFiles[0].text;
});

for (const signedIn of [false, true]) test(`${signedIn ? 'member' : 'guest'} password-first flow is stable, sanitized, uncached and reset on navigation`, async ({ page }) => {
  if (signedIn) await page.context().addCookies([{ name: 'session', value: 'isolated-member-fixture', domain: 'preview.test', path: '/' }]);
  const requests = [];
  let revoked = false, failure = false, delay = false;
  await page.route('https://preview.test/**', async route => {
    const req = route.request();
    if (!req.url().includes('/api/')) return route.fulfill({ contentType: 'text/html', body: '<div id="root"></div>' });
    requests.push(req.url());
    if (!req.url().includes('/api/public/article-preview')) return route.fulfill({ status: 401, headers: { 'X-Session-Status': 'invalid' }, json: {} });
    const { password, id } = req.postDataJSON();
    expect(req.headers().cookie).toBeUndefined();
    if (delay) await new Promise(r => setTimeout(r, 300));
    const ok = password === '1234' && !revoked;
    await route.fulfill({ status: failure ? 503 : ok ? 200 : 403, json: ok && !failure ? {
      article: { title: `Draft ${id}`, content: '<p>Private content</p><script>window.leaked=true</script>', published_date: 'bad-date' },
      authorName: 'Display Author',
    } : { error: 'Denied' } });
  });
  await page.goto('https://preview.test/article-preview/first');
  await page.addScriptTag({ content: script });
  await expect(page.getByText('Password Required')).toBeVisible();
  expect(requests).toHaveLength(0);
  await page.evaluate(() => { window.header = document.querySelector('header'); window.footer = document.querySelector('footer'); });
  const submit = async password => {
    await page.getByLabel('Access Password').fill(password);
    await page.getByTestId('button-submit-password').click();
  };
  await submit('wrong');
  await expect(page.getByRole('alert')).toContainText('password is incorrect');
  await submit('1234');
  await expect(page.getByRole('heading', { name: 'Draft first' })).toBeVisible();
  await expect(page.getByText('Display Author')).toBeVisible();
  expect(await page.evaluate(() => window.leaked)).toBeUndefined();
  expect(await page.evaluate(() => document.title)).toBe('Article Preview');
  await page.evaluate(() => window.navigate('/article-preview/second'));
  await expect(page.getByText('Password Required')).toBeVisible();
  await expect(page.getByText('Private content')).toHaveCount(0);
  revoked = true;
  await submit('1234');
  await expect(page.getByRole('alert')).toBeVisible();
  failure = true;
  await submit('1234');
  await expect(page.getByRole('alert')).toContainText('temporarily unavailable');
  failure = false; revoked = false; delay = true;
  await submit('1234');
  await page.evaluate(() => window.navigate('/article-preview/third'));
  await page.waitForTimeout(400);
  await expect(page.getByText('Password Required')).toBeVisible();
  await expect(page.getByText('Private content')).toHaveCount(0);
  expect(await page.evaluate(() => ({
    stable: window.header === document.querySelector('header') && window.footer === document.querySelector('footer'),
    rejections: window.rejections, clears: window.clears,
  }))).toEqual({ stable: true, rejections: 0, clears: 0 });
  expect(requests.every(url => url.includes('/api/public/article-preview') && !url.includes('1234'))).toBe(true);
});

test('full application guest chrome makes no protected entity requests or rejection cycles', async ({ page }) => {
  page.on('pageerror', error => console.log('Browser error:', error.message));
  test.setTimeout(120000);
  const protectedRequests = [];
  await page.addInitScript(() => {
    window.rejections = 0;
    window.addEventListener('viewer-session-rejected', () => window.rejections++);
  });
  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url());
    if (!url.pathname.startsWith('/api/')) return route.continue();
    let body = [];
    if (url.pathname.startsWith('/api/entities/')) {
      protectedRequests.push(url.pathname);
      return route.fulfill({ status: 401, headers: { 'X-Session-Status': 'invalid' }, json: {} });
    }
    if (url.pathname === '/api/auth/me') body = null;
    else if (url.pathname.includes('tenant-branding')) body = { id: 'fixture', name: 'Preview Fixture', header_config: {}, footer_config: {} };
    else if (url.pathname.includes('system-setting')) body = { setting_value: url.searchParams.get('key') === 'page_visibility_settings' ? '{}' : '' };
    else if (url.pathname.includes('portal-branding')) body = {};
    else if (url.pathname.includes('article-preview')) return route.fulfill({ status: 403, json: { error: 'Denied' } });
    else if (url.pathname.includes('article-settings')) body = { displayName: 'Articles' };
    return route.fulfill({ json: body });
  });
  await page.route('**/article-preview/*', async route => {
    if (route.request().resourceType() !== 'document') return route.continue();
    return route.fulfill({ contentType: 'text/html', body: `<html><head></head><body><div id="root"></div>
      <script type="module">import RefreshRuntime from '/@react-refresh';RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;</script>
      <script type="module" src="/src/main.jsx"></script></body></html>` });
  });
  await page.goto(`http://127.0.0.1:5000/article-preview/11111111-1111-4111-8111-111111111111`);
  await expect(page.getByText('Password Required')).toBeVisible({ timeout: 90000 });
  await page.evaluate(() => {
    window.chromeNodes = [...document.querySelectorAll('header,footer')];
  });
  await page.getByLabel('Access Password').fill('wrong');
  await page.getByTestId('button-submit-password').click();
  await expect(page.getByRole('alert')).toContainText('password is incorrect');
  await page.waitForTimeout(1000);
  expect(protectedRequests).toEqual([]);
  expect(await page.evaluate(() => window.rejections)).toBe(0);
  expect(await page.evaluate(() => window.chromeNodes.length > 0 && window.chromeNodes.every(n => n.isConnected))).toBe(true);
});
