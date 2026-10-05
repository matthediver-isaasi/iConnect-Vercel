import { test, expect } from '@playwright/test';
import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

// Real CreateEvent, release controls and route boundary; only services are isolated.
const stubs = {
  '@/api/base44Client': `export const base44 = window.fixture.base44;`,
  '@/hooks/useMemberAccess': `export const useMemberAccess = () => ({
    memberInfo: null, isAccessReady: true, isFeatureExcluded: () => false
  });`,
  '@/hooks/useEventTypes': `export const useEventTypes = () => ({ eventTypes: [] });`,
  '@/hooks/useInternalEventTypes': `export const useInternalEventTypes = () => ({ internalEventTypes: [] });`,
  '@/hooks/useAgendaItemTypes': `export const useAgendaItemTypes = () => ({ agendaItemTypes: [] });
    export const inferAgendaTypeBehaviour = () => ({});`,
  '@/hooks/useSpeakerModuleName': `export const useSpeakerModuleName = () => ({ singular: 'Speaker', plural: 'Speakers' });`,
  '@/hooks/useMemberGroupSettings': `export const useMemberGroupSettings = () => ({ ticketTypeName: 'Standard Ticket', featureName: 'Groups' });`,
};
function resolve(base) {
  return [base, ...['.jsx', '.js', '.mjs', '.ts', '.tsx', '/index.js', '/index.ts'].map(ext => base + ext)]
    .find(file => fs.existsSync(file) && fs.statSync(file).isFile()) || base;
}
let script;
let css;
test.beforeAll(async () => {
  test.setTimeout(120_000);
  const cssPath = '/tmp/create-event-ticket-expansion.css';
  execFileSync('node_modules/.bin/tailwindcss', ['-i', 'client/src/index.css', '-o', cssPath]);
  css = fs.readFileSync(cssPath, 'utf8');
  const bundle = await build({
    stdin: { resolveDir: process.cwd(), loader: 'jsx', contents: `
      import React from 'react';
      import { createRoot } from 'react-dom/client';
      import { BrowserRouter } from 'react-router-dom';
      import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
      import CreateEvent from './client/src/pages/CreateEvent.jsx';
      import { RouteLoadingBoundary } from './client/src/components/routing/RouteLoadingBoundary.jsx';
      const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      createRoot(document.getElementById('root')).render(
        <QueryClientProvider client={client}><BrowserRouter>
          <RouteLoadingBoundary resetKey="/CreateEvent"><CreateEvent /></RouteLoadingBoundary>
        </BrowserRouter></QueryClientProvider>);
    ` },
    bundle: true, write: false, outfile: 'fixture.js', jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"test"', 'import.meta.env.DEV': 'false' },
    plugins: [{
      name: 'isolated-create-event',
      setup(api) {
        api.onResolve({ filter: /.*/ }, args => {
          if (stubs[args.path]) return { path: args.path, namespace: 'fixture' };
          if (args.path.startsWith('@/')) return { path: resolve(path.resolve('client/src', args.path.slice(2))) };
          if (args.path.startsWith('@shared/')) return { path: resolve(path.resolve('shared', args.path.slice(8))) };
        });
        api.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ contents: stubs[args.path], loader: 'jsx', resolveDir: process.cwd() }));
        api.onLoad({ filter: /\.css$/ }, () => ({ contents: '', loader: 'css' }));
      },
    }],
  });
  script = bundle.outputFiles.find(file => file.path.endsWith('.js')).text;
});

async function mount(page) {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => route.request().url() === 'http://create-event.fixture/CreateEvent'
    ? route.fulfill({ contentType: 'text/html', body: '<html><body><div id="root"></div></body></html>' })
    : route.abort());
  await page.goto('http://create-event.fixture/CreateEvent');
  await page.addStyleTag({ content: css });
  await page.evaluate(() => {
    const unexpected = [];
    const reject = description => { unexpected.push(description); throw new Error(description); };
    window.fixture = {
      unexpected,
      completedSlugChecks: [],
      base44: {
        entities: new Proxy({}, { get: (_, entity) => ({
          list: async () => [], filter: async () => [], get: async () => null,
          create: () => reject(`Unexpected create ${entity}`),
          update: () => reject(`Unexpected update ${entity}`),
          delete: () => reject(`Unexpected delete ${entity}`),
        }) }),
        functions: { invoke: name => reject(`Unexpected function ${name}`) },
      },
    };
    window.fetch = async (url, options = {}) => {
      if ((options.method || 'GET') !== 'GET') return reject(`Unexpected write ${url}`);
      const responses = {
        '/api/zoom/webinars': [{ id: 'webinar-fixture', topic: 'Fixture webinar', status: 'scheduled', start_time: '2099-06-01T09:00:00Z', duration: 60, timezone: 'Asia/Tokyo' }],
        '/api/zoom/meetings': [{ id: 'meeting-fixture', topic: 'Fixture meeting', status: 'scheduled', start_time: '2099-06-01T09:00:00Z', duration: 60, timezone: 'America/New_York' }],
        '/api/admin/event-cpd-badge-rules?event_type=simple': { rules: [], badges: [] },
        '/api/admin/event-cpd-certificate-rules?event_type=simple': { rules: [], templates: [] },
        '/api/public/check-event-slug?slug=fixture-webinar': { available: true },
        '/api/public/check-event-slug?slug=fixture-meeting': { available: true },
      };
      if (!(String(url) in responses)) return reject(`Unexpected read ${url}`);
      const response = new Response(JSON.stringify(responses[String(url)]), { headers: { 'Content-Type': 'application/json' } });
      if (String(url).startsWith('/api/public/check-event-slug?')) {
        const readJson = response.json.bind(response);
        response.json = async () => {
          const result = await readJson();
          window.fixture.completedSlugChecks.push(String(url));
          return result;
        };
      }
      return response;
    };
  });
  await page.addScriptTag({ content: script });
  return async () => {
    await expect(page.getByText('Unable to load this page', { exact: true })).toHaveCount(0);
    expect(errors).toEqual([]);
    expect(await page.evaluate(() => window.fixture.unexpected)).toEqual([]);
  };
}
const releases = page => page.locator('[data-testid^="ticket-release-ticket-"]');
const names = page => page.locator('[data-testid^="input-ticket-name-"]');
const header = (page, name) => page.getByRole('tabpanel', { name: 'Details' }).getByText(name, { exact: true });
async function eventZone(page, label) {
  await page.getByRole('combobox').filter({ hasText: /London \(GMT\/BST\)|Paris \(CET\/CEST\)|Berlin \(CET\/CEST\)/ }).click();
  await page.getByRole('option', { name: label, exact: true }).click();
}

test('initial and added tickets expand safely, retaining edits and independent release timezone', async ({ page }) => {
  const assertHealthy = await mount(page);
  await header(page, 'Standard Ticket').click();
  await expect(names(page)).toHaveValue('Standard Ticket');
  await names(page).fill('Edited ticket');
  const price = page.locator('[data-testid^="input-ticket-price-"]');
  await price.fill('42.50');
  await releases(page).getByRole('switch').click();
  await expect(releases(page).getByRole('combobox')).toContainText('London');
  await releases(page).getByRole('combobox').click();
  await page.getByTestId('input-timezone-search').fill('Singapore');
  await page.getByTestId('option-timezone-Asia/Singapore').click();
  await eventZone(page, 'Paris (CET/CEST)');
  await expect(releases(page).getByRole('combobox')).toContainText('Singapore');
  await header(page, 'Edited ticket').click();
  await expect(names(page)).toHaveCount(0);
  await header(page, 'Edited ticket').click();
  await expect(names(page)).toHaveValue('Edited ticket');
  await expect(price).toHaveValue('42.50');
  await expect(releases(page).getByRole('combobox')).toContainText('Singapore');
  await page.getByTestId('button-add-ticket-class').click();
  await expect(names(page)).toHaveCount(2);
  await names(page).nth(1).fill('Second ticket');
  await releases(page).nth(1).getByRole('switch').click();
  await expect(releases(page).nth(1).getByRole('combobox')).toContainText('Paris');
  await header(page, 'Second ticket').click();
  await header(page, 'Second ticket').click();
  await expect(names(page).nth(1)).toHaveValue('Second ticket');
  await assertHealthy();
});

for (const kind of ['webinar', 'meeting']) {
  test(`selected Zoom ${kind} timezone takes precedence over event selection`, async ({ page }) => {
    const assertHealthy = await mount(page);
    await eventZone(page, 'Berlin (CET/CEST)');
    await page.getByTestId('event-type-online').locator('..').click();
    if (kind === 'meeting') await page.getByTestId('button-zoom-type-meeting').click();
    await page.getByTestId(`select-${kind}-trigger`).click();
    await page.getByTestId(`select-${kind}-${kind}-fixture`).click();
    await header(page, 'Standard Ticket').click();
    await releases(page).getByRole('switch').click();
    await expect(releases(page).getByRole('combobox')).toContainText(kind === 'webinar' ? 'Tokyo' : 'New York');
    await expect.poll(() => page.evaluate(() => window.fixture.completedSlugChecks))
      .toEqual([`/api/public/check-event-slug?slug=fixture-${kind}`]);
    await assertHealthy();
  });
}
