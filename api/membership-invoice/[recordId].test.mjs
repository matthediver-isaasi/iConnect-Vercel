import test from 'node:test';
import assert from 'node:assert/strict';
import { createMembershipInvoiceHandler } from './[recordId].js';
import { isResourceExcluded } from '../_lib/roleVisibility.js';

function response() {
  return {
    statusCode: 200,
    payload: undefined,
    headers: {},
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(value) {
      this.payload = value;
      return value;
    },
    setHeader(name, value) {
      this.headers[name] = value;
    },
    send(value) {
      this.payload = value;
      return value;
    },
  };
}

function mockedDb({
  rows = {},
  errors = {},
} = {}) {
  const calls = [];
  const db = {
    calls,
    from(table) {
      const call = { table, filters: {} };
      calls.push(call);
      const chain = {
        select() {
          return chain;
        },
        eq(column, value) {
          call.filters[column] = value;
          return chain;
        },
        maybeSingle() {
          const matchingRows = (rows[table] || []).filter((row) => Object.entries(call.filters)
            .every(([column, value]) => row[column] === value));
          return Promise.resolve({
            data: matchingRows[0] || null,
            error: errors[table] || null,
          });
        },
      };
      return chain;
    },
  };
  return db;
}

function endpoint({
  db,
  member = null,
  context = {
    isAuthenticated: true,
    tenantId: 'tenant-1',
    roleId: 'role-member',
  },
  admin = false,
  permission = true,
  provider = {
    fetchInvoicePdf: async () => Buffer.from('%PDF mocked'),
  },
} = {}) {
  let permissionCalls = 0;
  const providerLookups = [];
  const handler = createMembershipInvoiceHandler({
    db,
    getSessionMember: async () => member,
    getTenantContext: async () => context,
    hasAdminAccess: async () => admin,
    hasFeatureAccess: async (roleId, resource, memberExcludedFeatures) => {
      permissionCalls += 1;
      assert.equal(roleId, 'role-member');
      assert.equal(resource, 'commerce.history.access-invoices');
      return permission && !isResourceExcluded(memberExcludedFeatures, resource);
    },
    getAccountingProviderByName: async (name) => {
      providerLookups.push(name);
      return provider;
    },
    getAccountingProvider: async () => {
      throw new Error('current tenant provider must not be used for historical invoices');
    },
  });
  return {
    handler,
    getPermissionCalls: () => permissionCalls,
    getProviderLookups: () => providerLookups,
  };
}

const personalRecord = {
  id: 'personal-record',
  tenant_id: 'tenant-1',
  member_id: 'member-1',
  accounting_provider: 'quickbooks',
  accounting_invoice_id: 'qbo-invoice-1',
  accounting_invoice_number: 'QBO-1001',
  xero_invoice_id: null,
  xero_invoice_number: null,
};

const organisationRecord = {
  id: 'organisation-record',
  tenant_id: 'tenant-1',
  organization_id: 'org-1',
  accounting_provider: 'xero',
  accounting_invoice_id: null,
  accounting_invoice_number: null,
  xero_invoice_id: 'xero-invoice-1',
  xero_invoice_number: 'XERO-1001',
};

test('resolves a personal record independently of organisation assignment and supports inline PDF', async () => {
  const db = mockedDb({
    rows: { member_membership_history: [personalRecord] },
  });
  const providerCalls = [];
  const { handler, getProviderLookups } = endpoint({
    db,
    member: {
      id: 'member-1',
      tenant_id: 'tenant-1',
      organization_id: 'org-1',
      role_id: 'role-member',
    },
    provider: {
      fetchInvoicePdf: async (invoiceId, tenantId) => {
        providerCalls.push({ invoiceId, tenantId });
        return Buffer.from('%PDF personal');
      },
    },
  });
  const res = response();

  await handler({
    method: 'GET',
    query: { recordId: 'personal-record', source: 'personal', inline: 'true' },
  }, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.payload.toString(), '%PDF personal');
  assert.equal(res.headers['Content-Type'], 'application/pdf');
  assert.equal(res.headers['Content-Disposition'], 'inline; filename="membership-invoice-QBO-1001.pdf"');
  assert.deepEqual(providerCalls, [{ invoiceId: 'qbo-invoice-1', tenantId: 'tenant-1' }]);
  assert.deepEqual(getProviderLookups(), ['quickbooks']);
  assert.deepEqual(db.calls.map((call) => call.table), ['member_membership_history']);
});

test('supports organisation download and legacy Xero invoice fields', async () => {
  const db = mockedDb({
    rows: { organisation_membership_history: [organisationRecord] },
  });
  const { handler, getProviderLookups } = endpoint({
    db,
    member: {
      id: 'member-1',
      tenant_id: 'tenant-1',
      organization_id: 'org-1',
      role_id: 'role-member',
    },
  });
  const res = response();

  await handler({
    method: 'GET',
    query: { recordId: 'organisation-record', source: 'organisation' },
  }, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['Content-Length'], Buffer.from('%PDF mocked').length);
  assert.equal(
    res.headers['Content-Disposition'],
    'attachment; filename="membership-invoice-XERO-1001.pdf"',
  );
  assert.deepEqual(getProviderLookups(), ['xero']);
  assert.deepEqual(db.calls.map((call) => call.table), ['organisation_membership_history']);
});

test('uses Xero for legacy rows without a persisted provider', async () => {
  const db = mockedDb({
    rows: {
      member_membership_history: [{
        ...personalRecord,
        accounting_provider: null,
        accounting_invoice_id: 'legacy-xero-invoice',
        xero_invoice_id: null,
      }],
    },
  });
  const { handler, getProviderLookups } = endpoint({
    db,
    member: {
      id: 'member-1',
      tenant_id: 'tenant-1',
      organization_id: null,
      role_id: 'role-member',
    },
  });
  const res = response();

  await handler({
    method: 'GET',
    query: { recordId: 'personal-record', source: 'personal' },
  }, res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(getProviderLookups(), ['xero']);
});

test('record-ID-only callers resolve either ledger and admins bypass member ownership and RBAC', async () => {
  const db = mockedDb({
    rows: { organisation_membership_history: [organisationRecord] },
  });
  const { handler, getPermissionCalls } = endpoint({
    db,
    member: null,
    context: {
      isAuthenticated: true,
      tenantId: 'tenant-1',
      tenantUserId: 'tenant-admin',
    },
    admin: true,
    permission: false,
  });
  const res = response();

  await handler({ method: 'GET', query: { recordId: 'organisation-record' } }, res);

  assert.equal(res.statusCode, 200);
  assert.equal(getPermissionCalls(), 0);
  assert.deepEqual(
    db.calls.map((call) => call.table),
    ['organisation_membership_history', 'member_membership_history'],
  );
});

test('rejects invalid source values before querying a ledger', async () => {
  const db = mockedDb();
  const { handler } = endpoint({ db });
  const res = response();

  await handler({ method: 'GET', query: { recordId: 'record', source: 'organization' } }, res);

  assert.equal(res.statusCode, 400);
  assert.deepEqual(res.payload, { error: 'Invalid membership source' });
  assert.equal(db.calls.length, 0);
});

test('enforces invoice permission for nonadmins before record lookup', async () => {
  const db = mockedDb({
    rows: { member_membership_history: [personalRecord] },
  });
  const { handler, getPermissionCalls } = endpoint({
    db,
    member: {
      id: 'member-1',
      tenant_id: 'tenant-1',
      organization_id: null,
      role_id: 'role-member',
    },
    permission: false,
  });
  const res = response();

  await handler({
    method: 'GET',
    query: { recordId: 'personal-record', source: 'personal' },
  }, res);

  assert.equal(res.statusCode, 403);
  assert.equal(getPermissionCalls(), 1);
  assert.equal(db.calls.length, 0);
});

test('uses the authenticated member tenant and role instead of stale tenant context values', async () => {
  const db = mockedDb({
    rows: { member_membership_history: [personalRecord] },
  });
  const { handler, getPermissionCalls } = endpoint({
    db,
    context: {
      isAuthenticated: true,
      tenantId: 'tenant-1',
      roleId: 'context-role-with-access',
    },
    member: {
      id: 'member-1',
      tenant_id: 'tenant-1',
      organization_id: null,
      role_id: 'role-member',
    },
    permission: false,
  });
  const res = response();

  await handler({
    method: 'GET',
    query: { recordId: 'personal-record', source: 'personal' },
  }, res);

  assert.equal(res.statusCode, 403);
  assert.equal(getPermissionCalls(), 1);
  assert.equal(db.calls.length, 0);

  const crossTenantDb = mockedDb({
    rows: { member_membership_history: [personalRecord] },
  });
  const { handler: crossTenantHandler } = endpoint({
    db: crossTenantDb,
    context: {
      isAuthenticated: true,
      tenantId: 'tenant-2',
      roleId: 'context-role-with-access',
    },
    member: {
      id: 'member-1',
      tenant_id: 'tenant-1',
      organization_id: null,
      role_id: 'role-member',
    },
    permission: true,
  });
  const crossTenantResponse = response();

  await crossTenantHandler({
    method: 'GET',
    query: { recordId: 'personal-record', source: 'personal' },
  }, crossTenantResponse);

  assert.equal(crossTenantResponse.statusCode, 409);
  assert.equal(crossTenantDb.calls.length, 0);
});

test('denies invoice access when the member exclusion gates the history page', async () => {
  const db = mockedDb({
    rows: { member_membership_history: [personalRecord] },
  });
  const { handler } = endpoint({
    db,
    member: {
      id: 'member-1',
      tenant_id: 'tenant-1',
      organization_id: null,
      role_id: 'role-member',
      member_excluded_features: ['commerce.history'],
    },
  });
  const res = response();

  await handler({
    method: 'GET',
    query: { recordId: 'personal-record', source: 'personal' },
  }, res);

  assert.equal(res.statusCode, 403);
  assert.equal(db.calls.length, 0);
});

test('enforces personal and organisation ownership without crossing tenants', async () => {
  const otherMemberDb = mockedDb({
    rows: { member_membership_history: [personalRecord] },
  });
  const { handler: otherMemberHandler } = endpoint({
    db: otherMemberDb,
    member: {
      id: 'different-member',
      tenant_id: 'tenant-1',
      organization_id: null,
      role_id: 'role-member',
    },
  });
  const otherMemberResponse = response();
  await otherMemberHandler({
    method: 'GET',
    query: { recordId: 'personal-record', source: 'personal' },
  }, otherMemberResponse);
  assert.equal(otherMemberResponse.statusCode, 403);

  const otherTenantDb = mockedDb({
    rows: {
      member_membership_history: [{
        ...personalRecord,
        tenant_id: 'tenant-2',
      }],
    },
  });
  const { handler: otherTenantHandler } = endpoint({
    db: otherTenantDb,
    member: {
      id: 'member-1',
      tenant_id: 'tenant-1',
      organization_id: null,
      role_id: 'role-member',
    },
  });
  const otherTenantResponse = response();
  await otherTenantHandler({
    method: 'GET',
    query: { recordId: 'personal-record', source: 'personal' },
  }, otherTenantResponse);
  assert.equal(otherTenantResponse.statusCode, 404);
});

test('fails on membership query and accounting provider errors', async () => {
  const queryDb = mockedDb({
    errors: { member_membership_history: new Error('history query failed') },
  });
  const { handler: queryHandler } = endpoint({
    db: queryDb,
    member: {
      id: 'member-1',
      tenant_id: 'tenant-1',
      organization_id: null,
      role_id: 'role-member',
    },
  });
  const queryResponse = response();
  await queryHandler({
    method: 'GET',
    query: { recordId: 'personal-record', source: 'personal' },
  }, queryResponse);
  assert.equal(queryResponse.statusCode, 500);

  const providerDb = mockedDb({
    rows: { member_membership_history: [personalRecord] },
  });
  const { handler: providerHandler } = endpoint({
    db: providerDb,
    member: {
      id: 'member-1',
      tenant_id: 'tenant-1',
      organization_id: null,
      role_id: 'role-member',
    },
    provider: {
      fetchInvoicePdf: async () => {
        throw new Error('provider unavailable');
      },
    },
  });
  const providerResponse = response();
  await providerHandler({
    method: 'GET',
    query: { recordId: 'personal-record', source: 'personal' },
  }, providerResponse);
  assert.equal(providerResponse.statusCode, 500);
  assert.deepEqual(providerResponse.payload, {
    error: 'Failed to fetch invoice from accounting provider',
  });
});