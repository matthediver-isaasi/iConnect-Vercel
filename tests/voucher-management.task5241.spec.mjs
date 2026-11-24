import { test, expect } from '@playwright/test';

const origin = 'http://127.0.0.1:5000';
const ids = { tenant: '11111111-1111-4111-8111-111111111111', member: '22222222-2222-4222-8222-222222222222', org: '33333333-3333-4333-8333-333333333333', role: '44444444-4444-4444-8444-444444444444' };

async function fixture(page, { withOrg = true, adminSettings = false } = {}) {
  const role = { id: ids.role, tenant_id: ids.tenant, name: 'Fixture administrator', excluded_features: [] };
  const member = { id: ids.member, tenant_id: ids.tenant, role_id: ids.role, organization_id: withOrg ? ids.org : null,
    first_name: 'Alex', last_name: 'Fixture', email: 'alex@example.invalid', member_excluded_features: [],
    sessionExpiry: '2099-01-01T00:00:00Z',
    sessionRole: { status: 'ready', member_id: ids.member, tenant_id: ids.tenant, role_id: ids.role, session_key: 'voucher-fixture', role } };
  const organization = { id: ids.org, tenant_id: ids.tenant, name: 'Fixture Organisation', training_fund_balance: 0, program_ticket_balances: {} };
  const state = {
    tenant: ids.tenant, writes: [], blocked: [], reads: [], origins: {}, originRequests: [], originFailure: false,
    settings: [
      { id: 'enabled', setting_key: 'individual_vouchers_enabled', setting_value: 'true' },
      { id: 'org-label', setting_key: 'organization_voucher_display_name', setting_value: 'Team Credit' },
      { id: 'member-label', setting_key: 'member_voucher_display_name', setting_value: 'Personal Learning' },
    ],
    vouchers: [
      { id: 'personal-voucher', member_id: ids.member, organization_id: null, code: 'PERSONAL-FIXTURE', value: 75, status: 'active', issued_at: '2026-01-01', expires_at: '2099-01-01' },
      ...(withOrg ? [{ id: 'org-voucher', member_id: null, organization_id: ids.org, code: 'ORG-FIXTURE', value: 125, status: 'active', issued_at: '2026-01-01', expires_at: '2099-01-01' }] : []),
    ],
  };
  await page.addInitScript(({ member, organization, withOrg }) => {
    localStorage.clear(); sessionStorage.clear();
    localStorage.setItem('agcas_member', JSON.stringify(member));
    if (withOrg) localStorage.setItem('agcas_organization', JSON.stringify(organization));
  }, { member, organization, withOrg });
  await page.context().route('**/*', async route => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();
    const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body), headers: { 'Cache-Control': 'no-store' } });
    if (url.origin === origin && !path.startsWith('/api/')) return route.continue();
    if (url.origin !== origin) return route.abort();
    state.reads.push({ path, method, tenant: request.headers()['x-tenant-id'] });
    if (path === '/api/functions/getProgramEntitlements' && method === 'POST') return json({ entitlements: [] });
    if (path === '/api/admin/voucher-award-origins' && method === 'POST') {
      const body = request.postDataJSON();
      state.originRequests.push({ ...body, tenant: request.headers()['x-tenant-id'] });
      if (state.originGate) await state.originGate;
      return state.originFailure ? json({ error: 'Fixture metadata unavailable' }, 503)
        : json({ origins: Object.fromEntries(body.voucher_ids.filter(id => state.origins[id]).map(id => [id, state.origins[id]])) });
    }
    if (path.startsWith('/api/entities/SystemSettings') && ['POST', 'PUT', 'PATCH'].includes(method)) {
      const body = request.postDataJSON();
      const id = path.split('/')[4] || `setting-${state.writes.length}`;
      const existing = state.settings.find(row => row.id === id || row.setting_key === body.setting_key);
      const saved = { ...existing, ...body, id };
      state.settings = [...state.settings.filter(row => row !== existing), saved];
      state.writes.push({ entity: 'SystemSettings', body });
      return json(saved);
    }
    if (path === '/api/entities/Voucher' && method === 'POST') {
      const body = request.postDataJSON();
      state.writes.push({ entity: 'Voucher', body });
      const saved = { ...body, id: `issued-${state.writes.length}` };
      state.vouchers.push(saved);
      return json(saved);
    }
    if (method !== 'GET') {
      if (path.includes('/Member/') && Object.keys(request.postDataJSON() || {}).join() === 'last_activity') return json(member);
      state.blocked.push(`${method} ${path}`);
      return json({ error: 'Unapproved fixture mutation' }, 599);
    }
    if (path === '/api/auth/me') return json({ ...member, tenant_id: state.tenant,
      sessionRole: { ...member.sessionRole, tenant_id: state.tenant, role: { ...role, tenant_id: state.tenant } } });
    if (path === '/api/auth/tenant-user-me') return adminSettings
      ? json({ authenticated: true, tenantUser: { id: 'admin-fixture', role: 'owner', tenant_id: state.tenant }, tenant: { id: state.tenant, name: 'Voucher fixture', settings: {} } })
      : json({ authenticated: false }, 401);
    if (path === '/api/public/tenant-branding') return json({ success: true, branding: { id: state.tenant, name: 'Voucher fixture', headerConfig: {}, footerConfig: {} } });
    if (path === '/api/public/portal-branding') return json({ tenantName: 'Voucher fixture' });
    if (path === '/api/public/system-settings') return json(Object.fromEntries(state.settings.map(row => [row.setting_key, row.setting_value])));
    if (path === '/api/admin/voucher-members') return json({ members: [member] });
    if (path === '/api/admin/voucher-transactions') return json({ transactions: [], redemption_dates: {} });
    if (path.startsWith('/api/entities/SystemSettings')) {
      const filter = url.searchParams.get('filter');
      const parsed = filter ? JSON.parse(filter) : {};
      return json(state.settings.filter(row => !parsed.setting_key || row.setting_key === parsed.setting_key));
    }
    if (path === '/api/entities/Voucher') {
      const filter = JSON.parse(url.searchParams.get('filter') || '{}');
      return json(state.vouchers.filter(row => Object.entries(filter).every(([key, value]) => row[key] === value)));
    }
    if (path === '/api/entities/VoucherTransaction') return json(state.vouchers.map((voucher, index) => ({
      id: `txn-${index}`, voucher_id: voucher.id, organization_id: voucher.organization_id, owner_member_id: voucher.member_id,
      type: 'credit_adjustment', amount: 10, balance_before: 0, balance_after: 10, created_at: '2026-01-01T12:00:00Z',
    })));
    if (path === `/api/entities/Role/${ids.role}`) return json({ ...role, tenant_id: state.tenant });
    if (path === '/api/entities/Role') return json([{ ...role, tenant_id: state.tenant }]);
    if (path === `/api/entities/Member/${ids.member}`) return json({ ...member, tenant_id: state.tenant });
    if (path === '/api/entities/Member') return json([member]);
    if (path === `/api/entities/Organization/${ids.org}`) return json(organization);
    if (path === '/api/entities/Organization') return json([organization]);
    if (path === '/api/communication/inbox/unread-count') return json({ unreadCount: 0 });
    if (path === '/api/custom-objects') return json({ objects: [], total: 0 });
    if (path === '/api/my-badges') return json({ badges: [], isEligible: false });
    if (path === '/api/member/communication-preferences') return json({ categories: [], preferences: [] });
    return json([]);
  });
  return state;
}

test('settings independently trim and clear scheme names without changing the other', async ({ page }) => {
  const state = await fixture(page, { adminSettings: true });
  await page.goto('/admin/settings');
  await expect(page.locator('#organization_voucher_display_name')).toHaveValue('Team Credit');
  await page.locator('#organization_voucher_display_name').fill(' Credit ');
  await page.locator('#member_voucher_display_name').fill(' ');
  await page.getByRole('button', { name: 'Save voucher settings', exact: true }).click();
  await expect.poll(() => state.writes.filter(row => row.entity === 'SystemSettings').length).toBe(3);
  expect(state.settings.find(row => row.setting_key === 'organization_voucher_display_name').setting_value).toBe('Credit');
  expect(state.settings.find(row => row.setting_key === 'member_voucher_display_name').setting_value).toBe('');
  await page.locator('#member_voucher_display_name').fill(' My balance ');
  await page.locator('#organization_voucher_display_name').fill('');
  await page.getByRole('button', { name: 'Save voucher settings', exact: true }).click();
  await expect.poll(() => state.writes.length).toBe(6);
  expect(state.settings.find(row => row.setting_key === 'organization_voucher_display_name').setting_value).toBe('');
  expect(state.settings.find(row => row.setting_key === 'member_voucher_display_name').setting_value).toBe('My balance');
  expect(state.blocked).toEqual([]);
});

for (const withOrg of [false, true]) {
  test(`individual issuance works for member ${withOrg ? 'with' : 'without'} organisation`, async ({ page }) => {
    const state = await fixture(page, { withOrg });
    await page.goto('/VoucherManagement');
    await page.getByTestId('button-create-voucher').click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('combobox').first().click();
    await page.getByRole('option', { name: 'Individual member', exact: true }).click();
    await dialog.getByPlaceholder('Search members by name or email').fill('Alex');
    await dialog.getByRole('button', { name: /Alex Fixture/ }).click();
    await dialog.getByTestId('input-voucher-code').fill('MEMBER-NEW');
    await dialog.getByTestId('input-voucher-value').fill('50');
    await dialog.getByTestId('input-voucher-expiry').fill('2099-12-31');
    await dialog.getByRole('button', { name: 'Save Voucher', exact: true }).click();
    await expect.poll(() => state.writes.filter(row => row.entity === 'Voucher').length).toBe(1);
    const issued = state.writes.find(row => row.entity === 'Voucher').body;
    expect(issued.member_id).toBe(ids.member);
    expect(issued.organization_id).toBeNull();
    expect(issued.idempotency_key).toMatch(/^[0-9a-f-]{36}$/);
    expect(state.blocked).toEqual([]);
  });
}

test('balances and history display both owners; mounted settings cache changes with tenant intent', async ({ page }) => {
  const state = await fixture(page);
  await page.goto('/Balances');
  await expect(page.getByText('Personal Learning · Personal', { exact: true })).toBeVisible();
  await expect(page.getByText('Team Credit · Organisation', { exact: true })).toBeVisible();
  state.tenant = '55555555-5555-4555-8555-555555555555';
  state.settings = state.settings.map(row => ({ ...row, setting_value: row.setting_key === 'member_voucher_display_name' ? 'Tenant B Personal' : row.setting_key === 'organization_voucher_display_name' ? 'Tenant B Shared' : row.setting_value }));
  await page.evaluate(async tenant => {
    const { setActiveTenantId } = await import('/src/api/base44Client.js');
    setActiveTenantId(tenant);
  }, state.tenant);
  await expect(page.getByText('Tenant B Personal · Personal', { exact: true })).toBeVisible();
  await expect(page.getByText('Tenant B Shared · Organisation', { exact: true })).toBeVisible();
  await expect(page.getByText('Personal Learning · Personal', { exact: true })).toHaveCount(0);
  expect(state.reads.some(row => row.path === '/api/entities/SystemSettings' && row.tenant === state.tenant)).toBe(true);
  await page.goto('/History');
  await expect(page.getByText('Tenant B Personal · Personal', { exact: true }).first()).toBeVisible();
  await expect(page.getByText('Tenant B Shared · Organisation', { exact: true }).first()).toBeVisible();
  expect(state.blocked).toEqual([]);
});

test('personal balances and history remain visible without an organisation when issuance is off', async ({ page }) => {
  const state = await fixture(page, { withOrg: false });
  state.settings.find(row => row.setting_key === 'individual_vouchers_enabled').setting_value = 'false';
  state.settings.find(row => row.setting_key === 'member_voucher_display_name').setting_value = '';
  await page.goto('/Balances');
  await expect(page.getByText('Training Voucher · Personal', { exact: true })).toBeVisible();
  await expect(page.getByText('ORG-FIXTURE', { exact: true })).toHaveCount(0);
  await page.goto('/History');
  await expect(page.getByText('Training Voucher · Personal', { exact: true }).first()).toBeVisible();
  await page.goto('/VoucherManagement');
  await page.getByTestId('button-create-voucher').click();
  await expect(page.getByRole('dialog').getByPlaceholder('Search members by name or email')).toHaveCount(0);
  expect(state.writes).toEqual([]);
  expect(state.blocked).toEqual([]);
});

test('speaker origins display on existing organisation cards and detail, not unrelated or personal vouchers', async ({ page }) => {
  const state = await fixture(page);
  state.vouchers.push({ ...state.vouchers[1], id: 'training-voucher', code: 'TRAINING-FIXTURE', description: 'Existing agenda award' });
  state.origins['training-voucher'] = [{ speaker: 'Recorded Speaker', event: 'Parent Training Event', event_internal_reference: 'TRAIN-001' }];
  await page.goto('/VoucherManagement');
  const card = page.getByTestId('card-voucher-training-voucher');
  const origin = card.getByRole('region', { name: 'Speaker award origin' });
  await expect(origin.getByText('Speaker', { exact: true })).toBeVisible();
  await expect(origin.getByText('Recorded Speaker', { exact: true })).toBeVisible();
  await expect(origin.getByText('Event', { exact: true })).toBeVisible();
  await expect(origin.getByText('Parent Training Event', { exact: true })).toBeVisible();
  await expect(origin.getByText('Event internal reference', { exact: true })).toBeVisible();
  await expect(origin.getByText('TRAIN-001', { exact: true })).toBeVisible();
  await expect(page.getByTestId('card-voucher-org-voucher').getByRole('region')).toHaveCount(0);
  await expect(page.getByTestId('card-voucher-personal-voucher').getByText(/award origins|award origin/)).toHaveCount(0);
  await page.screenshot({ path: 'generated-artifacts/voucher-origins/list.jpg', fullPage: true });
  await card.click();
  await expect(page.getByRole('heading', { name: 'TRAINING-FIXTURE', exact: true })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Speaker award origin' }).getByText('TRAIN-001')).toBeVisible();
  await expect(page.getByText('Existing agenda award', { exact: true })).toBeVisible();
  await expect(page.getByText('£125.00', { exact: true })).toBeVisible();
  await page.screenshot({ path: 'generated-artifacts/voucher-origins/detail.jpg', fullPage: true });
  await expect.poll(() => state.originRequests.some(r => r.voucher_ids.length === 1 && r.voucher_ids[0] === 'training-voucher')).toBe(true);
  expect(state.originRequests.every(r => r.tenant === state.tenant && !r.voucher_ids.includes('personal-voucher'))).toBe(true);
  expect(state.writes).toEqual([]);
  expect(state.blocked).toEqual([]);
});

test('metadata failure keeps vouchers visible and retries in list and detail', async ({ page }) => {
  const state = await fixture(page);
  state.vouchers.push({ ...state.vouchers[1], id: 'other-org-voucher', code: 'OTHER-ORG' });
  state.originFailure = true;
  state.origins['org-voucher'] = [{ speaker: 'Recovered Speaker', event: 'Recovered Event', event_internal_reference: 'REF-RECOVERED' }];
  await page.goto('/VoucherManagement');
  const card = page.getByTestId('card-voucher-org-voucher');
  await expect(card.getByRole('alert')).toContainText('Speaker award origins could not be loaded');
  await expect(page.getByTestId('card-voucher-personal-voucher')).toBeVisible();
  state.originFailure = false;
  await card.getByRole('button', { name: 'Retry award origins' }).click();
  await expect(card.getByText('Recovered Speaker', { exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Voucher management', exact: true })).toBeVisible();
  state.originFailure = true;
  await card.click();
  await expect(page.getByRole('alert')).toContainText('Speaker award origins could not be loaded');
  state.originFailure = false;
  await page.getByRole('button', { name: 'Retry award origins' }).click();
  await expect(page.getByText('REF-RECOVERED', { exact: true })).toBeVisible();
  expect(state.writes).toEqual([]);
  expect(state.blocked).toEqual([]);
});

test('loading and missing sources stay distinct, and tenant changes never reuse old origin data', async ({ page }) => {
  const state = await fixture(page);
  let release;
  state.originGate = new Promise(resolve => { release = resolve; });
  state.origins['org-voucher'] = [{ speaker: null, event: 'Retained parent event', event_internal_reference: null }];
  await page.goto('/VoucherManagement');
  const card = page.getByTestId('card-voucher-org-voucher');
  await expect(card.getByRole('status')).toHaveText('Loading speaker award origins…');
  await expect(card.getByText('Unavailable', { exact: true })).toHaveCount(0);
  release();
  state.originGate = null;
  await expect(card.getByText('Retained parent event')).toBeVisible();
  await expect(card.getByText('Unavailable', { exact: true })).toHaveCount(2);
  state.tenant = '55555555-5555-4555-8555-555555555555';
  state.origins['org-voucher'] = [{ speaker: 'Other tenant speaker', event: 'Other tenant event', event_internal_reference: 'OTHER-REF' }];
  await page.evaluate(async tenant => {
    const { setActiveTenantId } = await import('/src/api/base44Client.js');
    setActiveTenantId(tenant);
  }, state.tenant);
  await expect(card.getByText('Other tenant speaker')).toBeVisible();
  await expect(page.getByText('Retained parent event')).toHaveCount(0);
  expect(state.originRequests.at(-1).tenant).toBe(state.tenant);
  expect(state.writes).toEqual([]);
  expect(state.blocked).toEqual([]);
});
