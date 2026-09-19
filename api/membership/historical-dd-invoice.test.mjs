import assert from 'node:assert/strict';
import test from 'node:test';
import { createHistoricalDdInvoiceHandler } from './historical-dd-invoice.js';

const RECORD_ID = '3e69cfdf-4d7c-4d70-9630-aa68f8c8fced';
const INVOICE_ID = 'da15de4f-4664-4be7-9fdf-dfe7b731c5bb';

function response() {
  return {
    statusCode: 200,
    body: undefined,
    headers: {},
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
    setHeader(name, value) { this.headers[name] = value; },
    send(body) { this.body = body; return this; },
  };
}

function dbMock({
  record = {
    id: RECORD_ID,
    tenant_id: 'tenant-1',
    member_id: 'member-1',
    xero_invoice_id: INVOICE_ID,
    xero_invoice_number: 'INV-100',
    historical_only: true,
  },
  error = null,
  betaRecord = null,
  betaLink = null,
  betaRecordError = null,
  betaLinkError = null,
} = {}) {
  const calls = [];
  return {
    calls,
    from(table) {
      const call = { table, filters: {} };
      calls.push(call);
      const query = {
        select() { return query; },
        eq(column, value) { call.filters[column] = value; return query; },
        maybeSingle() {
          const candidate = table === 'bnms_dd_beta_provider_history'
            ? betaRecord
            : (table === 'bnms_dd_beta_invoice_link' ? betaLink : record);
          const queryError = table === 'bnms_dd_beta_provider_history'
            ? betaRecordError
            : (table === 'bnms_dd_beta_invoice_link' ? betaLinkError : error);
          const matches = candidate && Object.entries(call.filters)
            .every(([key, value]) => candidate[key] === value);
          return Promise.resolve({ data: matches ? candidate : null, error: queryError });
        },
      };
      return query;
    },
  };
}

function endpoint({
  db = dbMock(),
  member = {
    id: 'member-1',
    tenant_id: 'tenant-1',
    role_id: 'role-1',
    member_excluded_features: [],
  },
  context = { isAuthenticated: true, tenantId: 'tenant-1' },
  admin = false,
  feature = async () => true,
  fetchPdf = async () => Buffer.from('%PDF historical'),
} = {}) {
  return createHistoricalDdInvoiceHandler({
    db,
    getSessionMember: async () => member,
    getTenantContext: async () => context,
    hasAdminAccess: async () => admin,
    hasFeatureAccess: feature,
    fetchXeroInvoicePdf: fetchPdf,
  });
}

async function invoke(handler, query = { recordId: RECORD_ID }) {
  const res = response();
  await handler({ method: 'GET', query }, res);
  return res;
}

test('validates method, authentication, UUID and inline selector', async () => {
  let res = response();
  await endpoint()({ method: 'POST', query: {} }, res);
  assert.equal(res.statusCode, 405);
  assert.equal(res.headers['Cache-Control'], 'private, no-store');

  res = await invoke(endpoint({ member: null, context: null }));
  assert.equal(res.statusCode, 401);
  res = await invoke(endpoint(), { recordId: 'not-a-uuid' });
  assert.equal(res.statusCode, 400);
  res = await invoke(endpoint(), { recordId: RECORD_ID, inline: 'yes' });
  assert.equal(res.statusCode, 400);
  res = await invoke(endpoint(), { recordId: RECORD_ID, source: 'provider-payment-id' });
  assert.equal(res.statusCode, 400);
});

test('uses authenticated member role and exclusions for both permissions', async () => {
  const calls = [];
  const exclusions = ['commerce.history.access-invoices.child'];
  const handler = endpoint({
    member: {
      id: 'member-1',
      tenant_id: 'tenant-1',
      role_id: 'member-role',
      member_excluded_features: exclusions,
    },
    context: { isAuthenticated: true, tenantId: 'tenant-1', roleId: 'context-admin-role' },
    feature: async (role, permission, suppliedExclusions) => {
      calls.push({ role, permission, suppliedExclusions });
      return permission === 'commerce.history';
    },
  });
  const res = await invoke(handler);
  assert.equal(res.statusCode, 403);
  assert.match(res.body.error, /Invoice access permission/);
  assert.deepEqual(calls, [
    { role: 'member-role', permission: 'commerce.history', suppliedExclusions: exclusions },
    {
      role: 'member-role',
      permission: 'commerce.history.access-invoices',
      suppliedExclusions: exclusions,
    },
  ]);
});

test('does not use context role when the persisted member has no role', async () => {
  let featureCalled = false;
  const res = await invoke(endpoint({
    member: { id: 'member-1', tenant_id: 'tenant-1', role_id: null },
    context: { isAuthenticated: true, tenantId: 'tenant-1', roleId: 'context-role' },
    feature: async () => { featureCalled = true; return true; },
  }));
  assert.equal(res.statusCode, 403);
  assert.equal(featureCalled, false);
  assert.match(res.body.error, /history access permission/);
});

test('requires the persisted historical record to belong to the authenticated member', async () => {
  const db = dbMock({
    record: {
      id: RECORD_ID,
      tenant_id: 'tenant-1',
      member_id: 'member-2',
      xero_invoice_id: INVOICE_ID,
      historical_only: true,
    },
  });
  const res = await invoke(endpoint({ db }));
  assert.equal(res.statusCode, 403);
  assert.match(res.body.error, /Not authorized/);
  assert.deepEqual(db.calls[0].filters, {
    id: RECORD_ID,
    tenant_id: 'tenant-1',
    historical_only: true,
  });
});

test('admin bypass is tenant scoped and uses the hardened member admin context', async () => {
  const db = dbMock({
    record: {
      id: RECORD_ID,
      tenant_id: 'tenant-1',
      member_id: 'another-member',
      xero_invoice_id: INVOICE_ID,
      xero_invoice_number: 'ADMIN-1',
      historical_only: true,
    },
  });
  let adminContext;
  const handler = createHistoricalDdInvoiceHandler({
    db,
    getSessionMember: async () => ({
      id: 'member-admin', tenant_id: 'tenant-1', role_id: 'admin-role',
    }),
    getTenantContext: async () => ({ isAuthenticated: true, tenantId: 'tenant-1' }),
    hasAdminAccess: async (context) => { adminContext = context; return true; },
    hasFeatureAccess: async () => { throw new Error('admin must bypass member permissions'); },
    fetchXeroInvoicePdf: async () => Buffer.from('%PDF admin'),
  });
  const res = await invoke(handler);
  assert.equal(res.statusCode, 200);
  assert.equal(adminContext.memberId, 'member-admin');
  assert.equal(adminContext.roleId, 'admin-role');
  assert.equal(adminContext.tenantId, 'tenant-1');
});

test('rejects cross-tenant context before querying the record', async () => {
  const db = dbMock();
  const res = await invoke(endpoint({
    db,
    member: { id: 'member-1', tenant_id: 'tenant-1', role_id: 'role-1' },
    context: { isAuthenticated: true, tenantId: 'tenant-2' },
  }));
  assert.equal(res.statusCode, 409);
  assert.equal(db.calls.length, 0);
});

test('returns clear missing record, missing invoice and migration errors', async () => {
  let res = await invoke(endpoint({ db: dbMock({ record: null }) }));
  assert.equal(res.statusCode, 404);
  assert.match(res.body.error, /invoice not found/i);

  res = await invoke(endpoint({
    db: dbMock({
      record: {
        id: RECORD_ID,
        tenant_id: 'tenant-1',
        member_id: 'member-1',
        xero_invoice_id: null,
        historical_only: true,
      },
    }),
  }));
  assert.equal(res.statusCode, 404);
  assert.match(res.body.error, /No invoice is linked/);

  res = await invoke(endpoint({ db: dbMock({ error: { code: '42P01' } }) }));
  assert.equal(res.statusCode, 503);
  assert.equal(res.body.code, 'HISTORICAL_DD_MIGRATION_NOT_INSTALLED');
});

test('serves a no-store PDF through the persisted Xero reference with a safe filename', async () => {
  const calls = [];
  const db = dbMock({
    record: {
      id: RECORD_ID,
      tenant_id: 'tenant-1',
      member_id: 'member-1',
      xero_invoice_id: INVOICE_ID,
      xero_invoice_number: 'INV-"bad\r\nname/100',
      historical_only: true,
    },
  });
  const res = await invoke(endpoint({
    db,
    fetchPdf: async (invoiceId, tenantId) => {
      calls.push({ invoiceId, tenantId });
      return Buffer.from('%PDF safe');
    },
  }), { recordId: RECORD_ID, inline: 'true' });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.toString(), '%PDF safe');
  assert.deepEqual(calls, [{ invoiceId: INVOICE_ID, tenantId: 'tenant-1' }]);
  assert.equal(res.headers['Content-Type'], 'application/pdf');
  assert.equal(res.headers['Cache-Control'], 'private, no-store');
  assert.equal(
    res.headers['Content-Disposition'],
    'inline; filename="membership-invoice-INV-bad-name-100.pdf"',
  );
});

test('sanitizes Xero connection, missing provider, and generic provider failures', async () => {
  const cases = [
    [new Error('No Xero token found for this tenant. secret-token'), 503, 'XERO_CONNECTION_UNAVAILABLE'],
    [new Error('Failed to fetch invoice PDF from Xero: 404'), 404, undefined],
    [new Error('upstream body contains private details'), 502, undefined],
  ];
  for (const [error, status, code] of cases) {
    const res = await invoke(endpoint({
      fetchPdf: async () => { throw error; },
    }));
    assert.equal(res.statusCode, status);
    assert.equal(res.body.code, code);
    assert.doesNotMatch(res.body.error, /secret-token|private details/);
  }
});

test('beta download resolves only an exact history owner and tenant invoice link', async () => {
  const calls = [];
  const db = dbMock({
    betaRecord: {
      id: RECORD_ID, tenant_id: 'tenant-1', member_id: 'member-1',
      accounting_reconciled: false,
    },
    betaLink: {
      history_id: RECORD_ID, tenant_id: 'tenant-1', member_id: 'member-1',
      xero_invoice_id: INVOICE_ID, xero_invoice_number: 'BETA-100',
    },
  });
  const res = await invoke(endpoint({
    db,
    fetchPdf: async (invoiceId, tenantId) => {
      calls.push({ invoiceId, tenantId });
      return Buffer.from('%PDF beta');
    },
  }), { recordId: RECORD_ID, source: 'beta_provider_history' });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(calls, [{ invoiceId: INVOICE_ID, tenantId: 'tenant-1' }]);
  assert.deepEqual(db.calls.map((call) => [call.table, call.filters]), [
    ['bnms_dd_beta_provider_history', {
      id: RECORD_ID, tenant_id: 'tenant-1', accounting_reconciled: false,
    }],
    ['bnms_dd_beta_invoice_link', {
      history_id: RECORD_ID, tenant_id: 'tenant-1', member_id: 'member-1',
    }],
  ]);
});

test('beta invoice link cannot authorize a different member and missing link storage is explicit', async () => {
  let fetchCalled = false;
  let db = dbMock({
    betaRecord: {
      id: RECORD_ID, tenant_id: 'tenant-1', member_id: 'member-2',
      accounting_reconciled: false,
    },
  });
  let res = await invoke(endpoint({
    db,
    fetchPdf: async () => { fetchCalled = true; return Buffer.from(''); },
  }), { recordId: RECORD_ID, source: 'beta_provider_history' });
  assert.equal(res.statusCode, 403);
  assert.equal(db.calls.length, 1);
  assert.equal(fetchCalled, false);

  db = dbMock({
    betaRecord: {
      id: RECORD_ID, tenant_id: 'tenant-1', member_id: 'member-1',
      accounting_reconciled: false,
    },
    betaLinkError: { code: '42P01' },
  });
  res = await invoke(endpoint({ db }), {
    recordId: RECORD_ID, source: 'beta_provider_history',
  });
  assert.equal(res.statusCode, 503);
  assert.equal(res.body.code, 'HISTORICAL_DD_BETA_INVOICE_LINK_MIGRATION_NOT_INSTALLED');
});