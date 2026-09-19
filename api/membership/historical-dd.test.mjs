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

function dbMock({
  member = { id: 'member-1', tenant_id: 'tenant-1' },
  payments = [],
  betaPayments = [],
  betaInvoiceLinks = [],
  paymentError = null,
  betaPaymentError = null,
  betaInvoiceLinkError = null,
  queryLog = [],
} = {}) {
  return {
    from(table) {
      queryLog.push({ table, filters: [] });
      const call = queryLog.at(-1);
      const query = {
        eq(column, value) { call.filters.push([column, value]); return query; },
        select() { return query; },
        order() {
          if (table === 'bnms_dd_beta_invoice_link') {
            return Promise.resolve({ data: betaInvoiceLinks, error: betaInvoiceLinkError });
          }
          return table === 'bnms_dd_beta_provider_history'
            ? Promise.resolve({ data: betaPayments, error: betaPaymentError })
            : Promise.resolve({ data: payments, error: paymentError });
        },
        maybeSingle() { return Promise.resolve({ data: member, error: null }); },
      };
      assert.ok([
        'member',
        'bnms_dd_historical_payment',
        'bnms_dd_beta_provider_history',
        'bnms_dd_beta_invoice_link',
      ].includes(table));
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

test('beta member history is tenant scoped, provider-only and never claims an invoice or activation', async () => {
  const queryLog = [];
  const handler = createHistoricalDdHandler({
    db: dbMock({
      queryLog,
      betaPayments: [{
        id: 'beta-1',
        charge_date: '2026-09-09',
        amount_minor: 1425,
        currency: 'GBP',
        provider_payment_id: 'PM-BETA',
        provider_status: 'paid_out',
        accounting_reconciled: false,
      }],
    }),
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
  assert.deepEqual(res.body.payments, [{
    id: 'beta-1',
    period: null,
    charge_date: '2026-09-09',
    amount_minor: 1425,
    currency: 'GBP',
    provider_payment_id: 'PM-BETA',
    provider_status: 'paid_out',
    xero_invoice_id: null,
    xero_invoice_number: null,
    invoice_available: false,
    invoice_unavailable_reason: 'accounting_unreconciled',
    historical_only: true,
    source: 'beta_provider_history',
    provenance: 'provider_evidence_only',
    provider_only: true,
    accounting_reconciled: false,
  }]);
  const betaQuery = queryLog.find(({ table }) => table === 'bnms_dd_beta_provider_history');
  assert.deepEqual(betaQuery.filters, [
    ['tenant_id', 'tenant-1'],
    ['member_id', 'member-1'],
    ['accounting_reconciled', false],
  ]);
  assert.equal('payment_status' in res.body.payments[0], false);
  assert.equal('entitlement' in res.body.payments[0], false);
});

test('tenant admin receives the same beta projection without weakening tenant ownership checks', async () => {
  const handler = createHistoricalDdHandler({
    db: dbMock({
      member: { id: 'member-1', tenant_id: 'tenant-admin' },
      betaPayments: [{
        id: 'beta-admin', charge_date: '2026-08-01', amount_minor: 1500,
        currency: 'GBP', provider_payment_id: 'PM-ADMIN',
        provider_status: 'paid_out', accounting_reconciled: false,
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
  assert.equal(res.body.payments[0].source, 'beta_provider_history');
  assert.equal(res.body.payments[0].invoice_available, false);
  assert.equal(res.body.payments[0].invoice_unavailable_reason, 'accounting_unreconciled');
});

test('an exact beta invoice link exposes a reconciled invoice without mutating provider history', async () => {
  const history = {
    id: 'beta-linked', charge_date: '2026-09-09', amount_minor: 1425,
    currency: 'GBP', provider_payment_id: 'PM-BETA', provider_status: 'paid_out',
    accounting_reconciled: false,
  };
  const handler = createHistoricalDdHandler({
    db: dbMock({
      betaPayments: [history],
      betaInvoiceLinks: [{
        history_id: history.id,
        tenant_id: 'tenant-1',
        member_id: 'member-1',
        xero_invoice_id: 'invoice-beta',
        xero_invoice_number: 'BETA-10',
      }],
    }),
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
  assert.deepEqual(res.body.payments[0], {
    id: 'beta-linked',
    period: null,
    charge_date: '2026-09-09',
    amount_minor: 1425,
    currency: 'GBP',
    provider_payment_id: 'PM-BETA',
    provider_status: 'paid_out',
    xero_invoice_id: 'invoice-beta',
    xero_invoice_number: 'BETA-10',
    invoice_available: true,
    invoice_unavailable_reason: null,
    historical_only: true,
    source: 'beta_provider_history',
    provenance: 'provider_and_accounting_evidence',
    provider_only: false,
    accounting_reconciled: true,
  });
});

test('beta reconciliation remains visible but invoice identifiers are redacted without invoice permission', async () => {
  const handler = createHistoricalDdHandler({
    db: dbMock({
      betaPayments: [{
        id: 'beta-linked', accounting_reconciled: false,
      }],
      betaInvoiceLinks: [{
        history_id: 'beta-linked', tenant_id: 'tenant-1', member_id: 'member-1',
        xero_invoice_id: 'secret-invoice-id', xero_invoice_number: 'SECRET-10',
      }],
    }),
    getSessionMember: async () => ({
      id: 'member-1', tenant_id: 'tenant-1', role_id: 'role-1',
      member_excluded_features: [],
    }),
    getTenantContext: async () => ({ isAuthenticated: true, tenantId: 'tenant-1' }),
    hasAdminAccess: async () => false,
    hasFeatureAccess: async (_role, permission) => permission === 'commerce.history',
  });
  const res = response();
  await handler(request(), res);
  assert.equal(res.body.payments[0].accounting_reconciled, true);
  assert.equal(res.body.payments[0].xero_invoice_id, null);
  assert.equal(res.body.payments[0].xero_invoice_number, null);
  assert.equal(res.body.payments[0].invoice_available, false);
  assert.equal(res.body.payments[0].invoice_unavailable_reason, 'permission_denied');
});

test('pilot rows retain invoice parity when beta history is also queried', async () => {
  const pilot = {
    id: 'pilot-1', period: '2026-01-01', charge_date: '2026-01-06',
    amount_minor: 1304, currency: 'GBP', provider_payment_id: 'PM-PILOT',
    provider_status: 'paid_out', xero_invoice_id: 'invoice-1',
    xero_invoice_number: 'INV-1', historical_only: true,
  };
  const handler = createHistoricalDdHandler({
    db: dbMock({ payments: [pilot] }),
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
  assert.equal(res.body.payments.length, 1);
  assert.equal(res.body.payments[0].source, 'pilot_historical_ledger');
  assert.equal(res.body.payments[0].provenance, 'provider_and_accounting_evidence');
  assert.equal(res.body.payments[0].invoice_available, true);
  assert.equal(res.body.payments[0].xero_invoice_number, 'INV-1');
});

test('missing beta migration is explicit rather than silently dropping authorized history', async () => {
  const handler = createHistoricalDdHandler({
    db: dbMock({ betaPaymentError: { code: '42P01', message: 'missing' } }),
    getSessionMember: async () => ({ id: 'member-1', tenant_id: 'tenant-1', role_id: 'role-1' }),
    getTenantContext: async () => ({ isAuthenticated: true, tenantId: 'tenant-1' }),
    hasAdminAccess: async () => false,
    hasFeatureAccess: async () => true,
  });
  const res = response();
  await handler(request(), res);
  assert.equal(res.statusCode, 503);
  assert.equal(res.body.code, 'HISTORICAL_DD_BETA_MIGRATION_NOT_INSTALLED');
});

test('missing beta invoice link table never silently claims history is unreconciled', async () => {
  const handler = createHistoricalDdHandler({
    db: dbMock({ betaInvoiceLinkError: { code: '42P01', message: 'missing' } }),
    getSessionMember: async () => ({ id: 'member-1', tenant_id: 'tenant-1', role_id: 'role-1' }),
    getTenantContext: async () => ({ isAuthenticated: true, tenantId: 'tenant-1' }),
    hasAdminAccess: async () => false,
    hasFeatureAccess: async () => true,
  });
  const res = response();
  await handler(request(), res);
  assert.equal(res.statusCode, 503);
  assert.equal(res.body.code, 'HISTORICAL_DD_BETA_INVOICE_LINK_MIGRATION_NOT_INSTALLED');
});