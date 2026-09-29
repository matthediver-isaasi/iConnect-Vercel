import { test, expect } from '@playwright/test';
import { build } from 'esbuild';
import path from 'node:path';

const ORG_ID = 'isolated-org-4858';
const YEARS = {
  current: { membershipYear: '2026/2027', yearNumber: 2, startDate: '2026-10-01' },
  next: { membershipYear: '2027/2028', yearNumber: 3, startDate: '2027-10-01' },
};
const PRIOR = { membershipYear: '2025/2026', yearNumber: 1, startDate: '2025-10-01' };
const cost = (year) => ({
  ...year,
  annualCost: 1200,
  finalCost: 1200,
  vatAmount: 240,
  vatRatePercent: 20,
  totalWithVat: 1440,
});

let script;
test.beforeAll(async () => {
  const mocks = {
    '@/api/base44Client': 'export const base44 = {entities:{}};',
    '@/contexts/MemberTerminologyContext': 'export const useMemberTerminology = () => ({memberLabel:"Member",memberLabelPlural:"Members"});',
    '@/components/MemberJoinLinkSection': 'export default () => null;',
    '@/components/FormInvoiceSettlementControl': 'export default () => null;',
    '@/utils': 'export const createPageUrl = value => value;',
    'react-router-dom': 'export const Link = ({children}) => children;',
    'sonner': `export const toast = {
      error(message) { const alert = document.createElement('div'); alert.setAttribute('role', 'alert'); alert.textContent = message; document.body.append(alert); },
      success(message) { const status = document.createElement('div'); status.setAttribute('role', 'status'); status.textContent = message; document.body.append(status); },
      info() {}
    };`,
  };
  const result = await build({
    stdin: {
      contents: `
        import React from 'react';
        import { createRoot } from 'react-dom/client';
        import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
        import OrgMembershipTab from './client/src/components/OrgMembershipTab.jsx';
        const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
        createRoot(document.getElementById('root')).render(
          <QueryClientProvider client={client}>
            <main><h1>Organisation membership — isolated established-member fixture</h1>
              <OrgMembershipTab organizationId="${ORG_ID}" />
            </main>
          </QueryClientProvider>
        );`,
      resolveDir: process.cwd(),
      loader: 'jsx',
    },
    bundle: true,
    write: false,
    jsx: 'automatic',
    alias: { '@': path.resolve('client/src') },
    plugins: [{
      name: 'isolated-boundaries',
      setup(b) {
        b.onResolve({ filter: /.*/ }, args => args.path in mocks ? { path: args.path, namespace: 'fixture' } : null);
        b.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ contents: mocks[args.path], loader: 'jsx' }));
      },
    }],
  });
  script = result.outputFiles[0].text;
});

async function mount(page, scenario = 'current', responseMode = 'error') {
  const current = scenario === 'next' ? PRIOR : YEARS.current;
  const next = scenario === 'next' ? YEARS.current : YEARS.next;
  const history = scenario === 'next'
    ? [{ id: 'historical-record-4858', membership_year: PRIOR.membershipYear, final_cost: 1200, currency: 'GBP', payment_status: 'paid', status: 'active' }]
    : [{ id: 'historical-record-4858', membership_year: PRIOR.membershipYear, final_cost: 1200, currency: 'GBP', payment_status: 'paid', status: 'expired' }];
  const requests = [];
  const unexpectedWrites = [];
  const unexpectedReads = [];
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => {
    const req = route.request();
    const url = new URL(req.url());
    const method = req.method();
    if (url.pathname === '/fixture.js') return route.fulfill({ contentType: 'text/javascript', body: script });
    if (url.pathname === '/') return route.fulfill({
      contentType: 'text/html',
      body: `<style>body{font:16px system-ui;color:#172033;background:#f6f8fb;margin:30px}
        main{max-width:1100px;margin:auto}.grid{display:grid;grid-template-columns:1fr 1fr;gap:24px}
        .flex{display:flex}.justify-between{justify-content:space-between}.items-center{align-items:center}
        button{padding:6px 12px;margin:4px;cursor:pointer}h1{font-size:24px}svg{width:16px;height:16px}
        .text-muted-foreground{color:#627084}.font-semibold{font-weight:600}</style>
        <div id="root"></div><script src="/fixture.js"></script>`,
    });
    if (url.pathname === '/api/membership/org-membership' && method === 'GET') return route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        config: { name: 'Year 1 structure', currency: 'GBP', billing_period: 'annual', pricing_model: 'flat', flat_cost: 1200 },
        fieldLabel: 'Members',
        currentYear: { label: current.membershipYear },
        currentYearCost: cost(current),
        nextYearPreview: cost(next),
        isNewOrg: false,
        history,
        bands: [],
      }),
    });
    if (url.pathname === '/api/membership/org-membership-invoicing' && method === 'GET') return route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        settings: {
          [current.membershipYear]: { invoicing_mode: 'manual', fees_approved: false },
          [next.membershipYear]: { invoicing_mode: 'manual', fees_approved: false },
        },
      }),
    });
    if (url.pathname === '/api/membership/membership-settings' && method === 'GET') return route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ require_approval: false, addons_enabled: false }),
    });
    if (url.pathname === '/api/membership/simulate-renewal' && method === 'POST') {
      requests.push({ path: url.pathname, payload: req.postDataJSON() });
      if (responseMode === 'success') return route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ mode: req.postDataJSON().mode, organization: 'Established Organisation', membershipYear: req.postDataJSON().targetYear, steps: [], finalCost: 1200, currency: 'GBP' }),
      });
      return route.fulfill({ status: 422, contentType: 'application/json', body: JSON.stringify({ error: 'Simulation fixture: no eligible schedule' }) });
    }
    if (url.pathname === '/api/membership/org-membership-invoicing' && method === 'POST') {
      requests.push({ path: url.pathname, payload: req.postDataJSON() });
      if (responseMode === 'success') return route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ message: 'Isolated invoice fixture accepted' }),
      });
      return route.fulfill({ status: 422, contentType: 'application/json', body: JSON.stringify({ error: 'Invoice fixture: year is not eligible' }) });
    }
    if (method !== 'GET') unexpectedWrites.push(`${method} ${req.url()}`);
    else unexpectedReads.push(req.url());
    return route.abort();
  });
  await page.goto('https://task4858.fixture.invalid/');
  await expect(page.getByTestId('text-year-current-year')).toHaveText(current.membershipYear);
  await expect(page.getByTestId('text-year-next-year')).toHaveText(next.membershipYear);
  await expect(page.getByTestId('button-renew-now-next-year')).toBeVisible();
  return { requests, unexpectedWrites, unexpectedReads, errors };
}

test('established organisation simulation sends each displayed year, surfaces errors and never writes', async ({ page }, testInfo) => {
  const evidence = await mount(page);
  for (const [prefix, year] of [['current-year', YEARS.current], ['next-year', YEARS.next]]) {
    await page.getByTestId(`button-simulate-${prefix}`).click();
    await expect(page.getByRole('alert').filter({ hasText: 'Simulation fixture: no eligible schedule' })).toHaveCount(prefix === 'current-year' ? 1 : 2);
    expect(evidence.requests.at(-1)).toEqual({
      path: '/api/membership/simulate-renewal',
      payload: { organizationId: ORG_ID, mode: 'manual', targetYear: await page.getByTestId(`text-year-${prefix}`).innerText() },
    });
  }
  expect(evidence.requests).toHaveLength(2);
  expect(evidence.unexpectedWrites).toEqual([]);
  expect(evidence.unexpectedReads).toEqual([]);
  expect(evidence.errors).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath('established-year-preview-errors.png'), fullPage: true });
});

test('established organisation manual renewal and next-year Invoice Now use visible years and surface endpoint errors', async ({ page }) => {
  const evidence = await mount(page);
  for (const [prefix, year] of [['current-year', YEARS.current], ['next-year', YEARS.next]]) {
    await page.getByTestId(`button-renew-now-${prefix}`).click();
    await expect(page.getByRole('alert').filter({ hasText: 'Invoice fixture: year is not eligible' })).toHaveCount(prefix === 'current-year' ? 1 : 2);
    expect(evidence.requests.at(-1)).toEqual({
      path: '/api/membership/org-membership-invoicing',
      payload: { organizationId: ORG_ID, membershipYear: await page.getByTestId(`text-year-${prefix}`).innerText() },
    });
  }
  await page.getByTestId('button-invoice-now-next-year').click();
  await expect(page.getByRole('alert').filter({ hasText: 'Invoice fixture: year is not eligible' })).toHaveCount(3);
  expect(evidence.requests.at(-1)).toEqual({
    path: '/api/membership/org-membership-invoicing',
    payload: { organizationId: ORG_ID, membershipYear: await page.getByTestId('text-year-next-year').innerText(), asOfDate: YEARS.next.startDate, advance: true },
  });
  expect(evidence.requests).toHaveLength(3);
  expect(evidence.unexpectedWrites).toEqual([]);
  expect(evidence.unexpectedReads).toEqual([]);
  expect(evidence.errors).toEqual([]);
});

test('established 2025/2026 history exposes Invoice Now for displayed 2026/2027 with correct payload and error', async ({ page }) => {
  const evidence = await mount(page, 'next');
  await expect(page.getByTestId('text-invoicing-complete-current-year')).toBeVisible();
  await expect(page.getByTestId('text-year-next-year')).toHaveText(YEARS.current.membershipYear);
  await page.getByTestId('button-invoice-now-next-year').click();
  await expect(page.getByRole('alert').filter({ hasText: 'Invoice fixture: year is not eligible' })).toBeVisible();
  expect(evidence.requests).toEqual([{
    path: '/api/membership/org-membership-invoicing',
    payload: { organizationId: ORG_ID, membershipYear: YEARS.current.membershipYear, asOfDate: YEARS.current.startDate, advance: true },
  }]);
  expect(evidence.unexpectedWrites).toEqual([]);
  expect(evidence.unexpectedReads).toEqual([]);
  expect(evidence.errors).toEqual([]);
});

test('established history manual and Invoice Now success fixtures target displayed 2026/2027 only', async ({ page }, testInfo) => {
  const evidence = await mount(page, 'next', 'success');
  await page.getByTestId('button-renew-now-next-year').click();
  await expect(page.getByRole('status').filter({ hasText: 'Isolated invoice fixture accepted' })).toBeVisible();
  await page.getByTestId('button-invoice-now-next-year').click();
  await expect(page.getByRole('status').filter({ hasText: 'Isolated invoice fixture accepted' })).toHaveCount(2);
  expect(evidence.requests).toEqual([
    { path: '/api/membership/org-membership-invoicing', payload: { organizationId: ORG_ID, membershipYear: await page.getByTestId('text-year-next-year').innerText() } },
    { path: '/api/membership/org-membership-invoicing', payload: { organizationId: ORG_ID, membershipYear: await page.getByTestId('text-year-next-year').innerText(), asOfDate: YEARS.current.startDate, advance: true } },
  ]);
  expect(evidence.unexpectedWrites).toEqual([]);
  expect(evidence.unexpectedReads).toEqual([]);
  expect(evidence.errors).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath('established-2026-2027-success.png'), fullPage: true });
});