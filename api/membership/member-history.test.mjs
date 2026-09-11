import test from 'node:test';
import assert from 'node:assert/strict';
import {
  compareMembershipHistory,
  createMemberHistoryHandler,
} from './member-history.js';
import { isResourceExcluded } from '../_lib/roleVisibility.js';

function response() {
  return {
    statusCode: 200,
    payload: undefined,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(value) {
      this.payload = value;
      return value;
    },
  };
}

function mockedDb({
  rows = {},
  bands = [],
  errors = {},
} = {}) {
  const calls = [];
  const db = {
    calls,
    from(table) {
      calls.push({ table, filters: {} });
      const call = calls.at(-1);
      const filters = call.filters;
      const chain = {
        select() {
          return chain;
        },
        eq(column, value) {
          filters[column] = value;
          return chain;
        },
        in(column, value) {
          filters[column] = value;
          return chain;
        },
        maybeSingle() {
          return Promise.resolve({ data: null, error: errors[table] || null });
        },
        then(resolve, reject) {
          let data = rows[table] || [];
          if (table === 'membership_tier_band') {
            data = bands;
          } else {
            data = data.filter((row) => Object.entries(filters)
              .every(([column, value]) => row[column] === value));
          }
          return Promise.resolve({
            data,
            error: errors[table] || null,
          }).then(resolve, reject);
        },
      };
      return chain;
    },
  };
  return db;
}

const member = {
  id: 'member-1',
  tenant_id: 'tenant-1',
  organization_id: 'org-1',
  role_id: 'role-member',
};

function historyHandler({
  db,
  sessionMember = member,
  permission = true,
  admin = false,
} = {}) {
  return createMemberHistoryHandler({
    db,
    getSessionMember: async () => sessionMember,
    getTenantContext: async () => ({
      isAuthenticated: true,
      tenantId: sessionMember?.tenant_id || 'tenant-1',
      memberId: sessionMember?.id || null,
      organizationId: sessionMember?.organization_id || null,
      roleId: sessionMember?.role_id || null,
    }),
    hasAdminAccess: async () => admin,
    hasFeatureAccess: async (roleId, resource, memberExcludedFeatures) => (
      permission
      && !!roleId
      && !isResourceExcluded(memberExcludedFeatures, resource)
    ),
  });
}

test('returns personal and assigned organisation history with provider fields and stable ordering', async () => {
  const db = mockedDb({
    rows: {
      member_membership_history: [{
        id: 'personal-2026',
        tenant_id: 'tenant-1',
        member_id: 'member-1',
        membership_year: '2026/2027',
        band_id: 'band-personal',
        created_at: '2026-01-02T00:00:00Z',
        accounting_provider: 'quickbooks',
        accounting_invoice_id: 'qbo-1',
        accounting_invoice_number: 'QBO-1',
        xero_invoice_id: null,
        xero_invoice_number: null,
      }, {
        id: 'personal-2025',
        tenant_id: 'tenant-1',
        member_id: 'member-1',
        membership_year: '2025/2026',
        band_id: null,
        created_at: '2025-01-02T00:00:00Z',
        accounting_provider: 'xero',
        accounting_invoice_id: null,
        accounting_invoice_number: null,
        xero_invoice_id: 'xero-personal',
        xero_invoice_number: 'XERO-PERSONAL',
      }],
      organisation_membership_history: [{
        id: 'organisation-2026',
        tenant_id: 'tenant-1',
        organization_id: 'org-1',
        membership_year: '2026/2027',
        band_id: 'band-organisation',
        created_at: '2026-01-01T00:00:00Z',
        accounting_provider: 'xero',
        accounting_invoice_id: null,
        accounting_invoice_number: null,
        xero_invoice_id: 'xero-org',
        xero_invoice_number: 'XERO-ORG',
      }],
    },
    bands: [
      { id: 'band-personal', label: 'Personal band' },
      { id: 'band-organisation', label: 'Organisation band' },
    ],
  });
  const res = response();
  const handler = historyHandler({ db });

  await handler({ method: 'GET' }, res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.payload.map((row) => [row.id, row.membership_source]), [
    ['personal-2026', 'personal'],
    ['organisation-2026', 'organisation'],
    ['personal-2025', 'personal'],
  ]);
  assert.equal(res.payload[0].band_label, 'Personal band');
  assert.equal(res.payload[0].accounting_invoice_id, 'qbo-1');
  assert.equal(res.payload[2].xero_invoice_id, 'xero-personal');
  assert.ok(db.calls.some((call) => call.table === 'member_membership_history'
    && call.filters.tenant_id === 'tenant-1'
    && call.filters.member_id === 'member-1'));
  assert.ok(db.calls.some((call) => call.table === 'organisation_membership_history'
    && call.filters.tenant_id === 'tenant-1'
    && call.filters.organization_id === 'org-1'));
});

test('returns personal history for a member without an organisation', async () => {
  const db = mockedDb({
    rows: {
      member_membership_history: [{
        id: 'personal-1',
        tenant_id: 'tenant-1',
        member_id: 'member-1',
        membership_year: '2025/2026',
      }],
    },
  });
  const res = response();
  const handler = historyHandler({
    db,
    sessionMember: { ...member, organization_id: null },
  });

  await handler({ method: 'GET' }, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.payload.length, 1);
  assert.equal(res.payload[0].membership_source, 'personal');
  assert.equal(db.calls.filter((call) => call.table === 'organisation_membership_history').length, 0);
});

test('returns organisation-only history for a member linked to an organisation', async () => {
  const db = mockedDb({
    rows: {
      member_membership_history: [],
      organisation_membership_history: [{
        id: 'organisation-only',
        tenant_id: 'tenant-1',
        organization_id: 'org-1',
        membership_year: '2025/2026',
      }],
    },
  });
  const res = response();
  const handler = historyHandler({ db });

  await handler({ method: 'GET' }, res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.payload.map((row) => [row.id, row.membership_source]), [
    ['organisation-only', 'organisation'],
  ]);
});

test('fails rather than returning partial history when either history query fails', async () => {
  const db = mockedDb({
    rows: {
      member_membership_history: [],
      organisation_membership_history: [],
    },
    errors: {
      organisation_membership_history: new Error('organisation query failed'),
    },
  });
  const res = response();
  const handler = historyHandler({ db });

  await handler({ method: 'GET' }, res);

  assert.equal(res.statusCode, 500);
  assert.deepEqual(res.payload, { error: 'Failed to fetch membership history' });
});

test('fails when band enrichment fails', async () => {
  const db = mockedDb({
    rows: {
      member_membership_history: [{
        id: 'personal-1',
        tenant_id: 'tenant-1',
        member_id: 'member-1',
        membership_year: '2025/2026',
        band_id: 'band-1',
      }],
    },
    errors: {
      membership_tier_band: new Error('band query failed'),
    },
  });
  const res = response();
  const handler = historyHandler({
    db,
    sessionMember: { ...member, organization_id: null },
  });

  await handler({ method: 'GET' }, res);

  assert.equal(res.statusCode, 500);
  assert.deepEqual(res.payload, { error: 'Failed to fetch membership history' });
});

test('enforces history role permission and member exclusions before ledger queries', async () => {
  const deniedDb = mockedDb({
    rows: { member_membership_history: [] },
  });
  const deniedResponse = response();
  const deniedHandler = historyHandler({ db: deniedDb, permission: false });

  await deniedHandler({ method: 'GET' }, deniedResponse);

  assert.equal(deniedResponse.statusCode, 403);
  assert.equal(deniedDb.calls.length, 0);

  const excludedDb = mockedDb({
    rows: { member_membership_history: [] },
  });
  const excludedResponse = response();
  const excludedHandler = historyHandler({
    db: excludedDb,
    sessionMember: {
      ...member,
      organization_id: null,
      member_excluded_features: ['commerce'],
    },
  });

  await excludedHandler({ method: 'GET' }, excludedResponse);

  assert.equal(excludedResponse.statusCode, 403);
  assert.equal(excludedDb.calls.length, 0);
});

test('does not fall back to a stale context role for history access', async () => {
  const db = mockedDb({
    rows: { member_membership_history: [] },
  });
  const res = response();
  const handler = createMemberHistoryHandler({
    db,
    getSessionMember: async () => ({ ...member, organization_id: null }),
    getTenantContext: async () => ({
      isAuthenticated: true,
      tenantId: 'tenant-1',
      roleId: 'context-role-with-access',
    }),
    hasAdminAccess: async () => false,
    hasFeatureAccess: async (roleId, resource) => {
      assert.equal(roleId, 'role-member');
      assert.equal(resource, 'commerce.history');
      return false;
    },
  });

  await handler({ method: 'GET' }, res);

  assert.equal(res.statusCode, 403);
  assert.equal(db.calls.length, 0);
});

test('allows admins to read history despite member history exclusions', async () => {
  const db = mockedDb({
    rows: {
      member_membership_history: [{
        id: 'personal-admin',
        tenant_id: 'tenant-1',
        member_id: 'member-1',
        membership_year: '2025/2026',
      }],
    },
  });
  const res = response();
  const handler = historyHandler({
    db,
    sessionMember: {
      ...member,
      organization_id: null,
      member_excluded_features: ['commerce.history'],
    },
    permission: false,
    admin: true,
  });

  await handler({ method: 'GET' }, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.payload[0].id, 'personal-admin');
});

test('uses deterministic tie breakers when history dates and years are invalid', () => {
  const rows = [
    {
      id: 'z-id',
      membership_year: 'not-a-year',
      created_at: 'not-a-date',
      membership_source: 'personal',
    },
    {
      id: 'a-id',
      membership_year: 'not-a-year',
      created_at: 'not-a-date',
      membership_source: 'organisation',
    },
  ];

  rows.sort(compareMembershipHistory);

  assert.deepEqual(rows.map((row) => row.id), ['z-id', 'a-id']);
  assert.equal(compareMembershipHistory(rows[0], rows[1]), -1);
  assert.ok(Number.isFinite(compareMembershipHistory(rows[0], rows[1])));
});