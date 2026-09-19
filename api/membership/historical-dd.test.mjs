import assert from 'node:assert/strict';
import test from 'node:test';
import { createHistoricalDdHandler } from './historical-dd.js';

function response() {
  return {
    statusCode: 200, body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

function dbMock({ member = { id: 'member-1', tenant_id: 'tenant-1' }, payments = [], paymentError = null } = {}) {
  return {
    from(table) {
      const query = {
        eq() { return query; },
        select() { return query; },
        order() { return Promise.resolve({ data: payments, error: paymentError }); },
        maybeSingle() { return Promise.resolve({ data: member, error: null }); },
      };
      assert.ok(['member', 'bnms_dd_historical_payment'].includes(table));
      return query;
    },
  };
}

function request(memberId = 'member-1') {
  return { method: 'GET', query: { memberId } };
}

test('requires authentication and never authorizes another member by id alone', async () => {
  const unauthenticated = createHistoricalDdHandler({
    db: dbMock(), getSessionMember: async () => null,
    getTenantContext: async () => null,
    hasFeatureAccess: async () => true,
  });
  let res = response();
  await unauthenticated(request(), res);
  assert.equal(res.statusCode, 401);

  const otherMember = createHistoricalDdHandler({
    db: dbMock(), getSessionMember: async () => ({ id: 'other', tenant_id: 'tenant-1' }),
    getTenantContext: async () => ({ isAuthenticated: true, tenantId: 'tenant-1' }),
    hasAdminAccess: async () => false,
    hasFeatureAccess: async () => true,
  });
  res = response();
  await otherMember(request(), res);
  assert.equal(res.statusCode, 403);
});

test('self reads only their tenant-scoped immutable rows', async () => {
  const payment = {
    id: 'payment-1', period: '2026-01-01', charge_date: '2026-01-06',
    amount_minor: 1304, currency: 'GBP', provider_payment_id: 'PM1',
    provider_status: 'paid_out', xero_invoice_id: '3e69cfdf-4d7c-4d70-9630-aa68f8c8fced',
    xero_invoice_number: 'INV-1', historical_only: true,
  };
  const handler = createHistoricalDdHandler({
    db: dbMock({ payments: [payment] }),
    getSessionMember: async () => ({
      id: 'member-1', tenant_id: 'tenant-1', role_id: 'role-1',
      member_excluded_features: [],
    }),
    getTenantContext: async () => ({ isAuthenticated: true, tenantId: 'tenant-1' }),
    hasAdminAccess: async () => false,
    hasFeatureAccess: async () => true,
  });
  const res = response();
  await handler(request(), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.payments.length, 1);
  assert.equal(res.body.payments[0].invoice_available, true);
  assert.equal(res.body.payments[0].invoice_unavailable_reason, null);
  assert.equal(res.body.payments[0].xero_invoice_url, undefined);
  assert.equal(res.body.payments[0].tenant_id, undefined);
  assert.equal(res.body.payments[0].member_id, undefined);
});

test('admin access remains tenant bound', async () => {
  const handler = createHistoricalDdHandler({
    db: dbMock({ member: null }),
    getSessionMember: async () => null,
    getTenantContext: async () => ({ isAuthenticated: true, tenantId: 'tenant-admin' }),
    hasAdminAccess: async () => true,
    hasFeatureAccess: async () => { throw new Error('admin must bypass feature gates'); },
  });
  const res = response();
  await handler(request(), res);
  assert.equal(res.statusCode, 404);
});

test('tenant admin explicitly bypasses member feature gates and can see invoice reference', async () => {
  const handler = createHistoricalDdHandler({
    db: dbMock({
      member: { id: 'member-1', tenant_id: 'tenant-admin' },
      payments: [{
        id: 'payment-1', period: '2026-01-01', charge_date: '2026-01-06',
        amount_minor: 1304, currency: 'GBP', provider_payment_id: 'PM1',
        provider_status: 'paid_out',
        xero_invoice_id: '3e69cfdf-4d7c-4d70-9630-aa68f8c8fced',
        xero_invoice_number: 'INV-1', historical_only: true,
      }],
    }),
    getSessionMember: async () => null,
    getTenantContext: async () => ({ isAuthenticated: true, tenantId: 'tenant-admin' }),
    hasAdminAccess: async () => true,
    hasFeatureAccess: async () => { throw new Error('admin must bypass feature gates'); },
  });
  const res = response();
  await handler(request(), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.payments[0].xero_invoice_number, 'INV-1');
  assert.equal(res.body.payments[0].invoice_available, true);
  assert.equal(res.body.payments[0].xero_invoice_url, undefined);
});

test('rejects a self session whose tenant conflicts with the active context', async () => {
  const handler = createHistoricalDdHandler({
    db: dbMock(),
    getSessionMember: async () => ({ id: 'member-1', tenant_id: 'tenant-1', role_id: 'role-1' }),
    getTenantContext: async () => ({ isAuthenticated: true, tenantId: 'tenant-2' }),
    hasAdminAccess: async () => false,
    hasFeatureAccess: async () => true,
  });
  const res = response();
  await handler(request(), res);
  assert.equal(res.statusCode, 409);
  assert.match(res.body.error, /Tenant context mismatch/);
});

test('missing migration is explicit and other data failures are not hidden', async () => {
  for (const [code, expectedStatus, expectedCode] of [
    ['42P01', 503, 'HISTORICAL_DD_MIGRATION_NOT_INSTALLED'],
    ['XX000', 500, undefined],
  ]) {
    const handler = createHistoricalDdHandler({
      db: dbMock({ paymentError: { code, message: 'failure' } }),
      getSessionMember: async () => ({ id: 'member-1', tenant_id: 'tenant-1', role_id: 'role-1' }),
      getTenantContext: async () => ({ isAuthenticated: true, tenantId: 'tenant-1' }),
      hasAdminAccess: async () => false,
      hasFeatureAccess: async () => true,
    });
    const res = response();
    await handler(request(), res);
    assert.equal(res.statusCode, expectedStatus);
    assert.equal(res.body.code, expectedCode);
  }
});

test('canonical history permission is required and invoice details have their own gate', async () => {
  const payment = {
    id: 'payment-1', period: '2026-01-01', charge_date: '2026-01-06',
    amount_minor: 1304, currency: 'GBP', provider_payment_id: 'PM1',
    provider_status: 'paid_out', xero_invoice_id: '3e69cfdf-4d7c-4d70-9630-aa68f8c8fced',
    xero_invoice_number: 'INV-1', historical_only: true,
  };
  const featureCalls = [];
  const common = {
    db: dbMock({ payments: [payment] }),
    getSessionMember: async () => ({
      id: 'member-1', tenant_id: 'tenant-1', role_id: 'role-1',
      member_excluded_features: [],
    }),
    getTenantContext: async () => ({ isAuthenticated: true, tenantId: 'tenant-1' }),
    hasAdminAccess: async () => false,
  };
  let handler = createHistoricalDdHandler({
    ...common,
    hasFeatureAccess: async (_role, feature) => {
      featureCalls.push(feature);
      return feature === 'commerce.history';
    },
  });
  let res = response();
  await handler(request(), res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(featureCalls, ['commerce.history', 'commerce.history.access-invoices']);
  assert.equal(res.body.payments[0].xero_invoice_id, null);
  assert.equal(res.body.payments[0].xero_invoice_number, null);
  assert.equal(res.body.payments[0].invoice_available, false);
  assert.equal(res.body.payments[0].invoice_unavailable_reason, 'permission_denied');
  assert.equal(res.body.payments[0].xero_invoice_url, undefined);

  handler = createHistoricalDdHandler({
    ...common,
    hasFeatureAccess: async () => false,
  });
  res = response();
  await handler(request(), res);
  assert.equal(res.statusCode, 403);
  assert.match(res.body.error, /history access permission/);
});

test('a display invoice number alone is not a PDF reference', async () => {
  const handler = createHistoricalDdHandler({
    db: dbMock({ payments: [{ id: 'payment-1', xero_invoice_number: 'INV-1' }] }),
    getSessionMember: async () => ({ id: 'member-1', tenant_id: 'tenant-1', role_id: 'role-1' }),
    getTenantContext: async () => ({ isAuthenticated: true, tenantId: 'tenant-1' }),
    hasAdminAccess: async () => false,
    hasFeatureAccess: async () => true,
  });
  const res = response();
  await handler(request(), res);
  assert.equal(res.body.payments[0].invoice_available, false);
  assert.equal(res.body.payments[0].invoice_unavailable_reason, 'not_linked');
  assert.equal(res.body.payments[0].xero_invoice_number, 'INV-1');
});