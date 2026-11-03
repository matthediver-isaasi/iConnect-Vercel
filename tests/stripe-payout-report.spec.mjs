import { test, expect } from '@playwright/test';
import { mkdir, readFile } from 'node:fs/promises';

// All network data is synthetic. No login, provider or database is contacted.
const tenant = 'tenant-payout-fixture';
const role = { id: 'finance-role', name: 'Finance administrator', excluded_features: [] };
const member = { id: 'finance-fixture', email: 'finance@example.invalid', first_name: 'Finance',
  last_name: 'Example', tenant_id: tenant, role_id: role.id, is_team_member: true, member_excluded_features: [],
  sessionRole: { status: 'ready', member_id: 'finance-fixture', tenant_id: tenant, role_id: role.id, role } };
const payout = { id: 'po_example', amount: 14700, currency: 'gbp', status: 'paid',
  arrivalDate: '2026-10-31', automatic: true, supported: true, mode: 'live' };
const row = { id: 'txn_example', type: 'charge', currency: 'gbp', gross: 15000, fee: 300, net: 14700,
  paymentDate: '2026-10-28T10:00:00Z', balanceDate: '2026-10-28T10:00:00Z',
  sourceId: 'ch_example', chargeId: 'ch_example', paymentIntentId: 'pi_example', refundId: null, stripeInvoiceId: null };

async function fixture(page, { fail = false, contactStatus = 'available', extraInvoices = [] } = {}) {
  const writes = [], modes = [];
  await page.addInitScript(() => {
    localStorage.clear(); sessionStorage.clear();
    URL.parse ??= (value, base) => { try { return new URL(value, base); } catch { return null; } };
  });
  await page.context().routeWebSocket('**/realtime/v1/websocket*', socket => socket.onMessage(() => {}));
  await page.context().route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    const json = (value, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) });
    if (url.origin !== 'http://127.0.0.1:5189') return json([]);
    if (!url.pathname.startsWith('/api/')) return route.continue();
    if (request.method() === 'PATCH' && url.pathname === `/api/entities/Member/${member.id}`) return json(member);
    if (request.method() !== 'GET') { writes.push(url.pathname); return json({ error: 'Read-only fixture' }, 405); }
    if (url.pathname === '/api/auth/me') return json(member);
    if (url.pathname === '/api/auth/tenant-user-me') return json({ authenticated: false }, 401);
    if (url.pathname === '/api/admin/stripe-payout-report') {
      modes.push(url.searchParams.get('mode'));
      if (url.searchParams.get('action') === 'evidence') {
        return json({ rows: url.searchParams.get('source') === 'booking' ? [{
          source: 'booking', sourceId: 'booking-example', reference: 'DEMO-001', paymentId: 'pi_example',
          provider: 'xero', id: 'example-invoice', number: 'DEMO-INV-001',
          contactStatus, contactName: contactStatus === 'available' ? 'Example Customer, Ltd' : null,
          url: 'https://go.xero.com/AccountsReceivable/View.aspx?InvoiceID=example-invoice',
        }, ...extraInvoices] : [], next: null });
      }
      if (url.searchParams.has('payout')) {
        return fail ? json({ error: 'Example provider failure. Nothing was changed.' }, 502)
          : json({ payout, rows: [row], next: null });
      }
      return json({ payouts: [payout, { ...payout, id: 'po_manual', automatic: false, supported: false,
        limitation: 'Manual and instant payout attribution is unsupported.' }], next: null });
    }
    if (url.pathname.startsWith('/api/entities/Role/')) return json(role);
    if (url.pathname === '/api/entities/Role') return json([role]);
    if (url.pathname.startsWith('/api/entities/Member/')) return json(member);
    if (url.pathname === '/api/entities/Member') return json([member]);
    if (url.pathname === '/api/custom-objects') return json({ objects: [], total: 0 });
    if (url.pathname === '/api/communication/inbox/unread-count') return json({ unreadCount: 0 });
    if (url.pathname === '/api/tenant-canvas-theme') return json({ theme: null });
    if (url.pathname === '/api/public/canvas-symbols') return json({ symbols: [] });
    if (url.pathname === '/api/public/ai-help-persona') return json({ enabled: false });
    if (url.pathname === '/api/public/favicon-url') return json({ faviconUrl: null });
    if (url.pathname.startsWith('/api/redirects/resolve')) return json({ found: false });
    return json([]);
  });
  return { writes, modes };
}

test('select payout, verify exact invoice, export complete CSV, switch mode and identify unsupported payout', async ({ page }) => {
  const state = await fixture(page);
  await page.goto('/StripePayoutReport');
  await expect(page.getByRole('heading', { name: 'Stripe Payout Reconciliation' })).toBeVisible();
  await page.getByRole('button', { name: 'View payout po_example', exact: true }).click();
  await expect(page.getByText('DEMO-INV-001', { exact: true })).toBeVisible();
  const invoice = page.getByRole('link', { name: 'DEMO-INV-001' });
  await expect(invoice).toHaveAttribute('href', /InvoiceID=example-invoice/);
  await expect(page.getByText('Xero customer/contact: Example Customer, Ltd', { exact: true })).toBeVisible();
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download CSV' }).click();
  const download = await downloadPromise;
  const csv = await readFile(await download.path(), 'utf8');
  expect(csv).toContain('txn_example');
  expect(csv).toContain('14700');
  expect(csv).toContain('DEMO-INV-001');
  expect(csv).toContain('DEMO-INV-001 [example-invoice]: Example Customer, Ltd');
  await mkdir('generated-artifacts/stripe-payout', { recursive: true });
  await page.screenshot({ path: 'generated-artifacts/stripe-payout/report-example.png', fullPage: true });
  await page.getByRole('button', { name: 'View payout po_manual', exact: true }).click();
  await expect(page.getByText('Manual and instant payout attribution is unsupported.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Download CSV' })).toBeDisabled();
  await page.getByRole('button', { name: 'Test', exact: true }).click();
  await expect(page.getByText('Test data · not live funds')).toBeVisible();
  expect(state.modes).toContain('test');
  expect(state.writes).toEqual([]);
});

test('provider failure is visible and cannot export', async ({ page }) => {
  const state = await fixture(page, { fail: true });
  await page.goto('/StripePayoutReport');
  await page.getByRole('button', { name: 'View payout po_example', exact: true }).click();
  await expect(page.getByText('Example provider failure. Nothing was changed.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Download CSV' })).toBeDisabled();
  expect(state.writes).toEqual([]);
});

test('missing Xero name leaves complete totals and CSV available on narrow screens', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await fixture(page, { contactStatus: 'connection_unavailable' });
  await page.goto('/StripePayoutReport');
  await page.getByRole('button', { name: 'View payout po_example', exact: true }).click();
  await expect(page.getByText('Xero customer/contact: Unavailable — Xero connection', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Download CSV' })).toBeEnabled();
  const promise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download CSV' }).click();
  const csv = await readFile(await (await promise).path(), 'utf8');
  expect(csv).toContain('Unavailable — Xero connection');
  expect(csv).toContain('14700');
});

test('multiple invoices retain names without duplicating transactions; conflicts withhold names', async ({ page }) => {
  await fixture(page, { extraInvoices: [
    { source: 'booking', reference: 'B2', paymentId: 'pi_example', provider: 'xero',
      id: 'second-invoice', number: 'DEMO-INV-002', contactName: 'Second Customer', contactStatus: 'available' },
    { source: 'booking', reference: 'B3', paymentId: 'pi_example', provider: 'quickbooks',
      id: 'third-invoice', number: 'QB-003', contactName: 'Must not show', contactStatus: 'available' },
  ] });
  await page.goto('/StripePayoutReport');
  await page.getByRole('button', { name: 'View payout po_example', exact: true }).click();
  await expect(page.getByText('Xero customer/contact: Second Customer', { exact: true })).toBeVisible();
  await expect(page.getByText('Xero customer/contact: Not applicable — non-Xero invoice', { exact: true })).toBeVisible();
  await expect(page.getByText('txn_example', { exact: true })).toHaveCount(1);
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download CSV' }).click();
  const csv = await readFile(await (await download).path(), 'utf8');
  expect(csv).toContain('DEMO-INV-002 [second-invoice]: Second Customer');
  expect(csv).not.toContain('Must not show');
});

test('conflicting evidence hides names and links but still exports financial totals', async ({ page }) => {
  await fixture(page, { extraInvoices: [{
    source: 'booking', reference: 'B2', paymentId: 'pi_example', provider: 'xero',
    id: 'example-invoice', number: 'CONFLICT', contactName: 'Must not show', contactStatus: 'available',
  }] });
  await page.goto('/StripePayoutReport');
  await page.getByRole('button', { name: 'View payout po_example', exact: true }).click();
  await expect(page.getByText('Xero customer/contact: Unavailable — conflicting evidence', { exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'CONFLICT' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Download CSV' })).toBeEnabled();
});
