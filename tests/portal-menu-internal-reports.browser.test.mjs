// Isolated browser fixtures: real menu editor, links and permission helpers;
// no tenant sessions, databases or external services.
// Run: node --test tests/portal-menu-internal-reports.browser.test.mjs
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import postcss from 'postcss';
import tailwindcss from 'tailwindcss';

const origin = 'http://portal-reports.example.test';
const objectId = '11111111-1111-4111-8111-111111111111';
const reportUrl = `/internal-reports/${objectId}/workforce`;
let browser;
let script;
let css;

before(async () => {
  const mocks = {
    'base44Client': `
      const state = () => window.fixture;
      const copy = value => JSON.parse(JSON.stringify(value));
      export const base44 = { entities: {
        PortalMenu: {
          list: async () => copy(state().records),
          create: async data => {
            const row = { ...copy(data), id: 'created-report-menu' };
            state().records.push(row); state().writes.push(copy(row)); return row;
          },
          update: async (id, data) => {
            const row = state().records.find(row => row.id === id);
            Object.assign(row, copy(data)); state().writes.push(copy(row)); return copy(row);
          },
          delete: async () => null,
        },
        SystemSettings: { list: async () => [] },
        IEditPage: { filter: async () => [] },
        DynamicDirectory: { list: async () => [] },
        RoleAccessItem: { list: async () => [] },
      } };
    `,
    'useMemberAccess': `export const useMemberAccess = () => ({
      isFeatureExcluded: () => false, isAccessReady: true,
      memberInfo: { id:'admin', tenant_id:'fixture', role_id:'admin-role' }
    });`,
    'usePortalNavigation': `
      const scope = ['fixture:admin:admin-role', 'fixture-session'];
      export const usePortalNavigationScope = () => scope;
      export const readNavigationRows = async load => load();
    `,
    'useTicketViewerKey': `const key=['fixture']; export const useTicketViewerKey = () => key;`,
    'useSalesSettings': `export const useQuoteNaming = () => ({ singular:'Proposal', plural:'Proposals', slug:'proposals' });`,
    'TenantBrandingContext': `export const useTenantBranding = () => ({ branding:{ id:'fixture' } });`,
    'sonner': `export const toast = { success: () => {}, error: message => window.fixture.errors.push(message) };`,
  };
  const result = await build({
    stdin: {
      contents: `
        import React from 'react';
        import { createRoot } from 'react-dom/client';
        import { MemoryRouter } from 'react-router-dom';
        import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
        import PortalMenuManagement from './client/src/pages/PortalMenuManagement.jsx';
        import PortalNavLink from './client/src/components/navigation/PortalNavLink.jsx';
        import { canAccessReportAwareMenuItem } from './client/src/lib/internalReportNavigation.js';
        import { resolvePortalMenuDestination } from './client/src/lib/portalMenuLinks.js';
        import { createPageUrl } from './client/src/utils/index.ts';
        const queryClient = new QueryClient({ defaultOptions: {
          queries: { retry:false, gcTime:0 }, mutations:{ retry:false, gcTime:0 }
        } });
        const root = createRoot(document.getElementById('root'));
        window.showEditor = () => root.render(
          <QueryClientProvider client={queryClient}><PortalMenuManagement /></QueryClientProvider>
        );
        window.showViewer = (ready, ids) => root.render(
          <MemoryRouter>
            <nav>{window.fixture.records.map(row => {
              const destination = resolvePortalMenuDestination(row, createPageUrl);
              const item = { ...destination, featureId:row.feature_id };
              const visible = canAccessReportAwareMenuItem(item, {
                ready, allowed:new Set(ids), origin:window.location.origin,
                isFeatureExcluded:feature => feature === 'admin.data-studio',
              });
              return visible ? <PortalNavLink key={row.id} destination={destination}>{row.title}</PortalNavLink> : null;
            })}</nav>
          </MemoryRouter>
        );
        window.showEditor();
      `,
      resolveDir: process.cwd(), loader: 'jsx',
    },
    bundle: true, write: false, jsx: 'automatic',
    alias: { '@': path.resolve('client/src') },
    define: { 'process.env.NODE_ENV': '"test"' },
    plugins: [{
      name: 'isolated-portal-report-dependencies',
      setup(plugin) {
        const names = Object.keys(mocks).join('|');
        plugin.onResolve({ filter: new RegExp(`(?:^|[/\\\\])(${names})(?:\\\\.js)?$`) }, args => ({
          path: args.path.split(/[/\\]/).pop().replace(/\.js$/, ''), namespace: 'fixture',
        }));
        plugin.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ contents: mocks[args.path], loader: 'js' }));
      },
    }],
  });
  script = result.outputFiles[0].text;
  css = (await postcss([tailwindcss({
    content: [
      'client/src/pages/PortalMenuManagement.jsx',
      'client/src/components/ui/{select,dialog,button,input,card,scroll-area,popover,command,switch,label,badge}.jsx',
    ],
  })]).process('@tailwind base; @tailwind components; @tailwind utilities;', { from: undefined })).css;
  browser = await chromium.launch({
    executablePath: execFileSync('which', ['chromium'], { encoding: 'utf8' }).trim(),
    headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
});
after(async () => { await browser?.close(); });

async function mount(t, { failCatalog = false, records = [] } = {}) {
  const context = await browser.newContext({ viewport: { width: 1200, height: 1000 } });
  t.after(() => context.close());
  const page = await context.newPage();
  page.setDefaultTimeout(10_000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  t.after(() => assert.deepEqual(errors, []));
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) throw new Error('Fixture attempted external access');
    if (url.pathname === '/PortalMenuManagement') {
      return route.fulfill({ contentType: 'text/html', body: '<html><body><div id="root"></div></body></html>' });
    }
    if (url.pathname === '/api/internal-reports/catalog') {
      return route.fulfill({ status: failCatalog ? 503 : 200, json: failCatalog ? { error: 'Unavailable' } : {
        reports: [{ object_id: objectId, report_id: 'workforce', name: 'Workforce', object_name: 'Departments' }],
      } });
    }
    if (url.pathname === '/api/custom-objects') return route.fulfill({ json: { data: [], total: 0 } });
    throw new Error(`Unexpected fixture request: ${url.pathname}`);
  });
  await page.goto(`${origin}/PortalMenuManagement`);
  await page.evaluate(records => { window.fixture = { records, writes: [], errors: [] }; }, records);
  await page.addStyleTag({ content: css });
  await page.addScriptTag({ content: script });
  await page.getByRole('heading', { name: 'Portal Menu Management', exact: true }).waitFor();
  return page;
}

async function selectReport(page) {
  await page.getByTestId('button-portal-page-select').click();
  await page.getByRole('option', { name: /Internal report: Workforce/ }).click();
  await page.getByText('Controlled by this report', { exact: false }).waitFor();
  assert.equal(await page.getByTestId('button-role-access-select').count(), 0);
}

test('create and reopen a report menu item, then enforce report View access without Data Studio', async t => {
  const page = await mount(t);
  await page.getByRole('button', { name: 'Add Item', exact: true }).first().click();
  await page.getByRole('dialog').getByRole('textbox').first().fill('Our workforce report');
  await selectReport(page);
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  const records = await page.evaluate(() => window.fixture.records);
  assert.equal(records.length, 1);
  assert.equal(records[0].url, reportUrl);
  assert.equal(records[0].link_type, 'internal');
  assert.equal(records[0].feature_id, `internal-report:${objectId}:workforce:view`);
  assert.equal(records[0].section, 'user');
  assert.equal(records[0].open_in_new_tab, false);

  await page.getByRole('button', { name: 'Edit Our workforce report', exact: true }).click();
  assert.match(await page.getByTestId('button-portal-page-select').innerText(), /Internal report: Workforce/);
  await page.getByRole('button', { name: 'Update', exact: true }).click();
  await page.getByRole('dialog').waitFor({ state: 'hidden' });

  // Even a legacy Data Studio feature must not suppress an authorized report.
  await page.evaluate(() => { window.fixture.records[0].feature_id = 'admin.data-studio'; });
  await page.evaluate(id => window.showViewer(true, [id]), `${objectId}:workforce`);
  await page.getByRole('link', { name: 'Our workforce report' }).waitFor();
  assert.equal(await page.getByRole('link').getAttribute('href'), reportUrl);
  await page.evaluate(() => window.showViewer(true, []));
  await page.getByRole('link').waitFor({ state: 'hidden' });
  await page.evaluate(id => window.showViewer(false, [id]), `${objectId}:workforce`);
  assert.equal(await page.getByRole('link').count(), 0);
});

test('editing an ordinary menu item clears its old generic permission and restores normal controls when switched back', async t => {
  const page = await mount(t, { records: [{
    id: 'existing', title: 'Committee report', url: 'Events', feature_id: 'events.view',
    link_type: 'internal', icon: 'FileText', section: 'admin', parent_id: '', display_order: 3, is_active: true,
  }] });
  await page.getByRole('button', { name: 'Edit Committee report', exact: true }).click();
  await selectReport(page);
  await page.getByRole('button', { name: 'Update', exact: true }).click();
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  let row = await page.evaluate(() => window.fixture.records[0]);
  assert.equal(row.url, reportUrl);
  assert.equal(row.display_order, 3);
  assert.equal(row.section, 'admin');
  assert.equal(row.icon, 'FileText');
  assert.match(row.feature_id, /^internal-report:/);
  await page.getByRole('button', { name: 'Edit Committee report', exact: true }).click();
  await page.getByTestId('button-portal-page-select').click();
  await page.getByRole('option', { name: /^Events(?:\s|\/|$)/ }).click();
  await page.getByTestId('button-role-access-select').waitFor();
  await page.getByRole('button', { name: 'Update', exact: true }).click();
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  row = await page.evaluate(() => window.fixture.records[0]);
  assert.equal(row.url, 'Events');
  assert.doesNotMatch(row.feature_id, /^internal-report:/);
});

test('catalogue failure is explicit and does not prevent editing unrelated pages', async t => {
  const page = await mount(t, { failCatalog: true });
  await page.getByRole('button', { name: 'Add Item', exact: true }).first().click();
  await page.getByRole('alert').filter({ hasText: 'Could not load internal reports' }).waitFor();
  await page.getByTestId('button-portal-page-select').click();
  assert.equal(await page.getByRole('option', { name: /Internal report:/ }).count(), 0);
  await page.getByRole('option', { name: /^Events(?:\s|\/|$)/ }).click();
  await page.getByRole('dialog').getByRole('textbox').first().fill('Our events');
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  assert.equal(await page.evaluate(() => window.fixture.records[0].url), 'Events');
});

test('an unavailable saved report remains identifiable rather than displaying an empty selection', async t => {
  const page = await mount(t, { failCatalog: true, records: [{
    id: 'unavailable', title: 'Saved workforce report', url: reportUrl,
    feature_id: 'admin.data-studio', link_type: 'internal', icon: 'FileText',
    section: 'user', parent_id: '', display_order: 0, is_active: true,
  }] });
  await page.getByRole('button', { name: 'Edit Saved workforce report', exact: true }).click();
  await page.getByText('This saved internal report is unavailable.', { exact: false }).waitFor();
  assert.match(await page.getByTestId('button-portal-page-select').innerText(), /Saved internal report unavailable/);
  await page.getByRole('button', { name: 'Update', exact: true }).click();
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  assert.equal(await page.evaluate(() => window.fixture.records[0].url), reportUrl);
});
