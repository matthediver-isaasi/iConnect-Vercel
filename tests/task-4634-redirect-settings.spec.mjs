import { test, expect } from '@playwright/test';
import { build } from 'esbuild';
import path from 'node:path';
import fs from 'node:fs';
import postcss from 'postcss';
import tailwindcss from 'tailwindcss';

let script;
let styles;
const mappings = [
  { id: 'prefix', priority: 1, source_pattern: '/', target_url: '/legacy', match_type: 'prefix', status_code: 301, is_active: true },
  { id: 'regex', priority: 2, source_pattern: '^/.*$', target_url: '/legacy', match_type: 'regex', status_code: 302, is_active: true },
  { id: 'exact', priority: 3, source_pattern: '/old', target_url: '/new', match_type: 'exact', status_code: 301, is_active: true },
];

test.beforeAll(async () => {
  const stubs = {
    '@/api/base44Client': `export const base44 = { entities: { RedirectMapping: {
      list: async () => window.fixture.mappings,
      create: async (...args) => window.fixture.mappingWrites.push(['create', args]),
      update: async (...args) => window.fixture.mappingWrites.push(['update', args]),
      delete: async (...args) => window.fixture.mappingWrites.push(['delete', args]),
    } } };`,
    '@/hooks/useMemberAccess': `const allowed = () => false; export const useMemberAccess = () => ({
      isAccessReady: true, authResolved: true, sessionValidated: true, isFeatureExcluded: allowed,
    });`,
    '@/utils': `export const createPageUrl = name => '/' + name;`,
  };
  const result = await build({
    stdin: {
      contents: `
        import React from 'react';
        import { createRoot } from 'react-dom/client';
        import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
        import { Toaster } from 'sonner';
        import RedirectManagement from './client/src/pages/RedirectManagement.jsx';
        createRoot(document.getElementById('root')).render(
          <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
            <RedirectManagement /><Toaster />
          </QueryClientProvider>);
      `,
      resolveDir: process.cwd(), loader: 'jsx',
    },
    bundle: true, write: false, jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"test"' },
    plugins: [{
      name: 'isolated-settings',
      setup(api) {
        api.onResolve({ filter: /^@\// }, args => {
          if (stubs[args.path]) return { path: args.path, namespace: 'stub' };
          const base = path.resolve('client/src', args.path.slice(2));
          return { path: [base, `${base}.js`, `${base}.jsx`, `${base}.ts`, `${base}.tsx`]
            .find(candidate => fs.existsSync(candidate) && fs.statSync(candidate).isFile()) };
        });
        api.onLoad({ filter: /.*/, namespace: 'stub' }, args => ({
          contents: stubs[args.path], loader: 'jsx', resolveDir: process.cwd(),
        }));
      },
    }],
  });
  script = result.outputFiles[0].text;
  styles = (await postcss([tailwindcss({ config: 'tailwind.config.ts' })])
    .process(fs.readFileSync('client/src/index.css', 'utf8'), { from: 'client/src/index.css' })).css;
});

async function mount(page, options = {}) {
  const writes = [];
  const unexpected = [];
  let saved = options.initial || {};
  let pendingSave;
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.hostname === 'settings.invalid' && url.pathname === '/api/redirects/settings') {
      if (route.request().method() === 'GET') {
        if (options.loading) return;
        return route.fulfill({ status: options.loadError ? 503 : 200, contentType: 'application/json',
          body: JSON.stringify(options.loadError ? { error: 'Settings temporarily unavailable' } : saved) });
      }
      const body = route.request().postDataJSON();
      writes.push({ method: route.request().method(), body });
      if (options.savePending) await new Promise(resolve => { pendingSave = resolve; });
      if (!options.saveError) saved = body;
      return route.fulfill({ status: options.saveError ? 403 : 200, contentType: 'application/json',
        body: JSON.stringify(options.saveError ? { error: 'Not authorized to change settings' } : saved) });
    }
    if (url.hostname === 'settings.invalid' && route.request().isNavigationRequest()) {
      return route.fulfill({ contentType: 'text/html', body: '<div id="root"></div>' });
    }
    unexpected.push(route.request().url());
    return route.abort();
  });
  const render = async () => {
    await page.goto('http://settings.invalid/RedirectManagement');
    await page.evaluate(mappings => { window.fixture = { mappings, mappingWrites: [] }; }, options.mappings || mappings);
    await page.addStyleTag({ content: styles });
    await page.addScriptTag({ content: script });
  };
  await render();
  return { writes, unexpected, render, finishSave: () => pendingSave?.() };
}

const toggle = page => page.getByRole('switch', { name: 'Redirect unknown pages to homepage' });

test('unset setting defaults off and warns about existing broad rules without mutation', async ({ page }) => {
  const { writes, unexpected } = await mount(page);
  await expect(toggle(page)).toBeEnabled();
  await expect(toggle(page)).not.toBeChecked();
  await expect(page.getByTestId('warning-broad-redirects')).toContainText('2 active broad prefix or regex redirects');
  await expect(page.getByTestId('row-redirect-prefix')).toBeVisible();
  await expect(page.getByTestId('row-redirect-regex')).toBeVisible();
  expect(await page.evaluate(() => window.fixture.mappingWrites)).toEqual([]);
  expect(writes).toEqual([]);
  expect(unexpected).toEqual([]);
  fs.mkdirSync('screenshots', { recursive: true });
  await page.screenshot({ path: 'screenshots/task-4634-settings-styled.png', fullPage: true });
});

test('loading keeps switch disabled and shows loading state', async ({ page }) => {
  await mount(page, { loading: true });
  await expect(toggle(page)).toBeDisabled();
  await expect(page.getByRole('status')).toContainText('Loading fallback setting');
});

test('load failure disables switch and exposes error', async ({ page }) => {
  await mount(page, { loadError: true });
  await expect(toggle(page)).toBeDisabled();
  await expect(page.getByRole('alert')).toContainText('Settings temporarily unavailable');
});

test('enable and disable persist with PUT without modifying mapping rules', async ({ page }) => {
  const { writes, render } = await mount(page);
  await expect(toggle(page)).toBeEnabled();
  await toggle(page).click();
  await expect(toggle(page)).toBeChecked();
  await render();
  await expect(toggle(page)).toBeChecked();
  await toggle(page).click();
  await expect(toggle(page)).not.toBeChecked();
  await render();
  await expect(toggle(page)).toBeEnabled();
  await expect(toggle(page)).not.toBeChecked();
  expect(writes).toEqual([
    { method: 'PUT', body: { redirect_unknown_pages_to_homepage: true } },
    { method: 'PUT', body: { redirect_unknown_pages_to_homepage: false } },
  ]);
  expect(await page.evaluate(() => window.fixture.mappingWrites)).toEqual([]);
  await expect(page.getByTestId('warning-broad-redirects')).toBeVisible();
});

test('save pending disables switch until confirmed response', async ({ page }) => {
  const fixture = await mount(page, { savePending: true });
  await expect(toggle(page)).toBeEnabled();
  await toggle(page).click();
  await expect(toggle(page)).toBeDisabled();
  await expect(toggle(page)).not.toBeChecked();
  await expect.poll(() => fixture.writes.length).toBe(1);
  fixture.finishSave();
  await expect(toggle(page)).toBeEnabled();
  await expect(toggle(page)).toBeChecked();
});

test('save failure leaves persisted state unchanged with visible error', async ({ page }) => {
  const { writes } = await mount(page, { saveError: true });
  await expect(toggle(page)).toBeEnabled();
  await toggle(page).click();
  await expect(page.getByText('Failed to update fallback setting: Not authorized to change settings')).toBeVisible();
  await expect(toggle(page)).toBeEnabled();
  await expect(toggle(page)).not.toBeChecked();
  expect(writes).toHaveLength(1);
  expect(await page.evaluate(() => window.fixture.mappingWrites)).toEqual([]);
});

test('inactive broad rules and exact rules do not show broad warning', async ({ page }) => {
  await mount(page, { mappings: mappings.map(mapping => ({ ...mapping, is_active: mapping.match_type === 'exact' })) });
  await expect(toggle(page)).toBeEnabled();
  await expect(page.getByTestId('warning-broad-redirects')).toHaveCount(0);
});