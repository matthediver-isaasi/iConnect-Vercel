import { test, expect } from '@playwright/test';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import { snapshotDb } from '../scripts/audit-bnms-renewal-readiness.mjs';
import { loadFormMembershipRenewalContext } from '../api/_lib/formMembershipRenewalContext.js';

// No backend, database client, production login or provider is started.
// Auth is a synthetic browser response, NOT proof of production authentication.
const tenant = 'ff2df806-b321-4254-b651-3af11fccf1db';
const member = { id: 'synthetic-member', tenant_id: tenant, first_name: 'Synthetic',
  last_name: 'Acceptance', email: 'acceptance@example.invalid', status: 'active', role_id: 'synthetic-role' };
const config = { id: 'assigned-only', tenant_id: tenant, name: 'Assigned synthetic annual',
  start_mode: 'immediate', structure_scope_type: 'member', billing_period: 'annual',
  is_active: true, effective_from: '2026-09-01', flat_cost: 120, pricing_model: 'flat', currency: 'GBP' };
const history = { id: 'synthetic-history', tenant_id: tenant, member_id: member.id,
  membership_year: '2025/2026', status: 'active', payment_status: 'paid', payment_method: 'upfront',
  billing_period: 'annual', currency: 'GBP', tier_label: 'Full', term_start_date: null, term_end_date: '2026-09-25',
  notes: JSON.stringify({ source: 'bnms_non_dd_current_backfill', version: 1, sourceHash: 'a'.repeat(64),
    paymentAuthority: 'operator_attested_upfront_paid_2025_2026', expiryAuthority: 'retained_legacy_expiry',
    startDateAuthority: 'unknown_not_inferred', termAuthority: 'operator_attested_existing_2025_2026' }) };
const tables = {
  member: [member], member_membership_history: [history], membership_billing_agreements: [],
  membership_successor_election: [], membership_tier_config: [config],
  membership_expiry_policy_assignment: [{ id: 'synthetic-assignment', tenant_id: tenant,
    member_id: member.id, history_id: history.id, config_id: config.id, config_name: config.name,
    approval_source: 'operator', expiry_date: history.term_end_date,
    policy_snapshot: { renewal_open_days: 90, renewal_grace_days: 90,
      renewal_disable_login: true, renewal_change_role: false, renewal_fallback_role_id: null } }],
};
let server;
test.beforeAll(async () => {
  server = await createServer({
    configFile: false, envFile: false, root: path.resolve('client'),
    define: { 'import.meta.env.VITE_SUPABASE_URL': JSON.stringify('https://synthetic.invalid'),
      'import.meta.env.VITE_SUPABASE_ANON_KEY': JSON.stringify('synthetic-not-a-credential') },
    plugins: [react()], cacheDir: '/tmp/bnms-renewal-vite-cache',
    resolve: { alias: { '@': path.resolve('client/src'), '@shared': path.resolve('shared'),
      '@assets': path.resolve('attached_assets') } },
    server: { host: '127.0.0.1', port: 5195, strictPort: true },
  });
  await server.listen();
});
test.afterAll(async () => { await server?.close(); });

async function mount(page, { rollout = true, now = '2026-10-05', switchFixture = null } = {}) {
  const before = JSON.stringify(tables);
  const pricing = [];
  const context = await loadFormMembershipRenewalContext(snapshotDb(tables, { rollout }),
    { tenantId: tenant, memberId: member.id, now,
      simulate: async (_tenant, owner, options) => {
        pricing.push(options);
        expect(owner).toBe(member.id);
        expect(options.configId).toBe(config.id);
        expect(options.termStartDate).toBe('2026-09-26');
        return { success: true, config, membershipYear: { label: 'Synthetic successor',
          start: '2026-09-26', end: '2027-09-25' }, totalWithVat: 120 };
      } });
  expect(JSON.stringify(tables)).toBe(before);
  const calls = [], mutations = [], errors = [];
  const form = { id: 'synthetic-form', slug: 'membership-renewal', name: 'Membership renewal',
    fields: [{ id: 'renewal', type: 'membership_payment', label: 'Membership renewal', required: true }],
    pages: [], visibility_rules: [], entity_pipelines: {}, prefill_source: 'member',
    require_authentication: true, is_active: true, form_type: 'application' };
  const response = { renewal: context.renewal, memberScoped: true,
    ...(context.simulation || !rollout ? { membershipYear: 'Synthetic successor',
      entityName: 'Synthetic Acceptance', currency: 'GBP', finalCost: 120, totalWithVat: 120,
      tierLabel: config.name, costBreakdown: {} } : {}),
    stripeEnabled: false, directDebit: null, cardMonthly: null };
  if (switchFixture) Object.assign(response, {
    renewal: { ...context.renewal, state: 'renewal_pending', eligible: false,
      electionId: '10000000-0000-4000-8000-000000000001', selectedMethod: 'upfront' },
    stripeEnabled: true,
    directDebit: { monthlyAmount: 10, instalmentCount: 12, planTotal: 120, currency: 'GBP' },
    cardMonthly: { monthlyAmount: 10, instalmentCount: 12, planTotal: 120, currency: 'GBP' },
  });
  page.on('pageerror', error => { errors.push(error.message); console.error('Browser error:', error.message); });
  await page.context().route('**/*', async route => {
    const req = route.request(), url = new URL(req.url()), p = url.pathname;
    const json = (body, status = 200) => route.fulfill({ status,
      contentType: 'application/json', body: JSON.stringify(body) });
    if (url.origin !== 'http://127.0.0.1:5195') return route.abort();
    if (switchFixture && p === '/api/forms/membership-payment' && req.method() === 'POST') {
      const body = req.postDataJSON();
      switchFixture.calls.push(body);
      expect(body.action).toBe('change_renewal_payment_method');
      expect(body.electionId).toBe('10000000-0000-4000-8000-000000000001');
      expect(body.memberId).toBe(member.id);
      if (switchFixture.wait) await switchFixture.wait;
      else await new Promise(resolve => setTimeout(resolve, 100));
      if (switchFixture.refuse) return json({ error: 'Payment is processing. Check renewal status before making another payment.' }, 409);
      response.renewal = { ...context.renewal, eligible: true };
      return json({ released: true });
    }
    if (!['GET', 'HEAD'].includes(req.method())) {
      // Layout's visit heartbeat is expected but must never leave this fixture.
      if (p === `/api/entities/Member/${member.id}` && req.method() === 'PATCH'
          && Object.keys(req.postDataJSON()).join() === 'last_activity') {
        return json({ error: 'Activity write deliberately blocked' }, 403);
      }
      mutations.push(p); return json({ error: 'All mutations forbidden in acceptance' }, 403);
    }
    if (!p.startsWith('/api/')) return route.continue();
    calls.push(p);
    if (p === '/api/auth/me') return json(member);
    if (p === '/api/auth/tenant-user-me') return json({ user: member, tenant: { id: tenant, slug: 'bnms' } });
    if (p === '/api/public/form/membership-renewal') return json(form);
    if (p === `/api/entities/Member/${member.id}`) return json(member);
    if (p === '/api/entities/Member') return json([member]);
    if (p === '/api/entities/Role/synthetic-role') return json({ id: 'synthetic-role', name: 'Member', excluded_features: [] });
    if (p === '/api/forms/membership-payment') {
      expect(url.searchParams.get('memberId')).toBe(member.id);
      return json(response);
    }
    if (p === '/api/membership/payment-plan') return json({ currentPlan: null });
    return json([]);
  });
  await page.goto('/FormView?slug=membership-renewal');
  try {
    await expect.poll(() => calls.includes('/api/forms/membership-payment'), { timeout: 45000 }).toBe(true);
  } catch (error) { console.error({ calls, errors, body: await page.locator('body').innerText() }); throw error; }
  return { context, pricing, mutations, errors };
}

test('keyboard method switching waits for cancellation then restores all offered methods', async ({ page }) => {
  let release;
  const fixture = { calls: [], wait: new Promise(resolve => { release = resolve; }) };
  const result = await mount(page, { switchFixture: fixture });
  const button = page.getByRole('button', { name: 'Change payment method', exact: true });
  await expect(button).toBeVisible();
  await expect(page.getByText('Pay monthly by card', { exact: true })).toHaveCount(0);
  await button.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('status')).toContainText('Checking your payment');
  await expect(page.getByRole('button', { name: 'Confirming cancellation…' })).toBeDisabled();
  release();
  await expect(page.getByText('Pay monthly by card', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Change payment method', exact: true })).toHaveCount(0);
  expect(fixture.calls).toHaveLength(1);
  expect(result.errors).toEqual([]);
});

test('provider commitment refusal is announced and does not expose a replacement method', async ({ page }) => {
  const fixture = { calls: [], refuse: true };
  const result = await mount(page, { switchFixture: fixture });
  await page.getByRole('button', { name: 'Change payment method', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Payment is processing');
  await expect(page.getByText('Pay monthly by card', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Change payment method', exact: true })).toBeEnabled();
  expect(fixture.calls).toHaveLength(1);
  expect(result.errors).toEqual([]);
});

test('gate-open real FormView preserves assigned structure and original expiry during grace', async ({ page }) => {
  const result = await mount(page);
  const summary = page.getByTestId('membership-renewal-summary');
  await expect(summary).toContainText('25/09/2026');
  await expect(summary).toContainText('26/09/2026 to 25/09/2027');
  await expect(summary).toContainText('Your renewal covers:');
  await expect(summary).not.toContainText('administrator attestation');
  await expect(summary).not.toContainText('Historical commencement');
  expect(result.pricing).toHaveLength(1);
  expect(result.mutations).toEqual([]);
  expect(result.errors).toEqual([]);
  await page.screenshot({ path: '/tmp/bnms-renewal-gate-open.png' });
});

for (const [now, expected] of [['2026-06-26', 'renewal_not_open'], ['2026-06-27', 'eligible_renewal'],
  ['2026-12-24', 'eligible_renewal'], ['2026-12-25', 'renewal_closed']]) {
  test(`90/90 boundary ${now}: ${expected}`, async ({ page }) => {
    const result = await mount(page, { now });
    expect(result.context.renewal.state).toBe(expected);
    await expect(page.getByTestId('membership-renewal-summary')).toContainText('26/09/2026');
    expect(result.mutations).toEqual([]);
    expect(result.errors).toEqual([]);
  });
}

test('disabled gate exposes current legacy joining fallback, not renewal acceptance', async ({ page }) => {
  const result = await mount(page, { rollout: false });
  expect(result.context.renewal.renewalChoicesUnavailable).toBe(true);
  expect(result.context.renewal.state).toBe('joining');
  expect(result.pricing).toHaveLength(0);
  await expect(page.getByTestId('membership-payment-renewal')).toBeVisible();
  await expect(page.getByTestId('membership-renewal-summary')).toHaveCount(0);
  expect(result.mutations).toEqual([]);
  expect(result.errors).toEqual([]);
  await page.screenshot({ path: '/tmp/bnms-renewal-gate-closed.png' });
});
