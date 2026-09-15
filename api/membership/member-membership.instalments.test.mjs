import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemberMembershipHandler } from './member-membership.js';

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

function instalmentDb({
  histories = {},
  agreements = {},
  plans = {},
  stripeRows = [],
  gcRows = [],
  errors = {},
} = {}) {
  const calls = [];
  const db = {
    calls,
    from(table) {
      const state = {
        table,
        selected: null,
        filters: {},
        ranges: [],
        limits: [],
        orders: [],
        count: null,
      };
      calls.push(state);
      const chain = {
        select(columns, options) {
          state.selected = columns;
          state.count = options?.count || null;
          return chain;
        },
        eq(column, value) {
          state.filters[column] = value;
          return chain;
        },
        in(column, values) {
          state.filters[column] = values;
          return chain;
        },
        order(column, options) {
          state.orders.push({ column, ascending: options?.ascending });
          return chain;
        },
        limit(value) {
          state.limits.push(value);
          return chain;
        },
        range(first, last) {
          state.ranges.push([first, last]);
          return chain;
        },
        maybeSingle() {
          const data = table === 'membership_billing_agreements'
            ? agreements[state.filters.id] || null
            : histories[table]?.[state.filters.id] || null;
          return Promise.resolve({ data, error: errors[table] || null });
        },
        then(resolve, reject) {
          let data = [];
          if (table === 'membership_payment_plans') {
            data = (plans[state.filters.billing_agreement_id] || []).slice();
          } else if (table === 'membership_instalment_invoices') {
            data = stripeRows.filter((row) => (
              row.tenant_id === state.filters.tenant_id
              && row.billing_agreement_id === state.filters.billing_agreement_id
            ));
          } else if (table === 'gocardless_payments') {
            data = gcRows.filter((row) => (
              row.tenant_id === state.filters.tenant_id
              && state.filters.plan_id?.includes(row.plan_id)
              && state.filters.status?.includes(row.status)
            ));
          }
          const error = errors[table] || null;
          const count = state.count === 'exact' ? data.length : null;
          return Promise.resolve({ data, count, error }).then(resolve, reject);
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
  role_id: 'member-role',
};

function endpoint({
  db,
  sessionMember = member,
  context = {
    isAuthenticated: true,
    tenantId: 'tenant-1',
    roleId: 'member-role',
  },
  admin = false,
} = {}) {
  return createMemberMembershipHandler({
    db,
    getSessionMember: async () => sessionMember,
    getTenantContext: async () => context,
    hasAdminAccess: async () => admin,
  });
}

const personalHistory = {
  id: 'history-1',
  tenant_id: 'tenant-1',
  member_id: 'member-1',
  organization_id: null,
  membership_year: '2026/2027',
  billing_period: 'monthly_direct_debit',
  billing_agreement_id: 'agreement-1',
};

const stripeAgreement = {
  id: 'agreement-1',
  tenant_id: 'tenant-1',
  member_id: 'member-1',
  organization_id: null,
  provider: 'stripe',
  status: 'active',
  metadata: {
    card: {
      invoicing_mode: 'per_instalment',
      membership_year: '2026/2027',
      instalment_count: 12,
      monthly_amount_minor: 1000,
      currency: 'GBP',
    },
  },
};

test('returns a bounded, deterministic Stripe instalment page for the owning member', async () => {
  const db = instalmentDb({
    histories: { member_membership_history: { 'history-1': personalHistory } },
    agreements: { 'agreement-1': stripeAgreement },
    plans: {
      'agreement-1': [{
        id: 'plan-1',
        tenant_id: 'tenant-1',
        billing_agreement_id: 'agreement-1',
        member_id: 'member-1',
        organization_id: null,
        provider: 'stripe',
        status: 'active',
        amount_minor: 1000,
        currency: 'GBP',
        membership_year: '2026/2027',
        instalments_total: 12,
        instalments_paid: 2,
        created_at: '2026-04-01T00:00:00Z',
      }],
    },
    stripeRows: [{
      id: 'inst-1',
      tenant_id: 'tenant-1',
      billing_agreement_id: 'agreement-1',
      plan_id: 'plan-1',
      external_payment_id: 'stripe-invoice-1',
      amount_minor: 1000,
      currency: 'GBP',
      accounting_provider: 'xero',
      accounting_invoice_id: 'xero-inst-1',
      accounting_invoice_number: 'INV-001',
      accounting_sync_status: 'posted',
      accounting_sync_error: null,
      accounting_synced_at: '2026-04-02T00:00:00Z',
      created_at: '2026-04-01T00:00:00Z',
    }],
  });
  const res = response();
  const handler = endpoint({ db });

  await handler({
    method: 'GET',
    query: { recordId: 'history-1', instalments: 'true', page: '1' },
  }, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.payload.modeSnapshot.invoicingMode, 'per_instalment');
  assert.equal(res.payload.planCollectedCount, 2);
  assert.equal(res.payload.ledger.state, 'present');
  assert.equal(res.payload.ledger.totalCount, 1);
  assert.equal(res.payload.instalments[0].paymentRef, 'stripe-invoice-1');
  assert.equal(res.payload.instalments[0].invoiceNumber, 'INV-001');
  assert.match(res.payload.instalments[0].invoiceUrl, /instalment=true/);
  assert.deepEqual(
    db.calls.find((call) => call.table === 'membership_instalment_invoices').ranges,
    [[0, 24]],
  );
});

test('shaped ledger entries expose missing-provider and unpaid-invoice reasons', async () => {
  const skippedDb = instalmentDb({
    histories: { member_membership_history: { 'history-1': personalHistory } },
    agreements: { 'agreement-1': stripeAgreement },
    stripeRows: [{
      id: 'inst-skipped',
      tenant_id: 'tenant-1',
      billing_agreement_id: 'agreement-1',
      external_payment_id: 'stripe-invoice-skipped',
      amount_minor: 1000,
      currency: 'GBP',
      accounting_provider: null,
      accounting_sync_status: 'skipped',
      accounting_sync_error: 'no accounting provider connected',
      created_at: '2026-04-01T00:00:00Z',
    }],
  });
  const skippedRes = response();
  await endpoint({ db: skippedDb })({
    method: 'GET',
    query: { recordId: 'history-1', instalments: 'true' },
  }, skippedRes);

  const skipped = skippedRes.payload.instalments[0];
  assert.equal(skipped.accountingSyncState, 'missing_provider');
  assert.equal(skipped.missingProvider, true);
  assert.equal(skipped.accountingSyncReason, 'no accounting provider connected');
  assert.equal(skipped.accountingSyncError, 'no accounting provider connected');
  assert.equal(skipped.syncError, 'no accounting provider connected');
  assert.equal(skipped.invoiceUrl, null);

  const gcHistory = {
    ...personalHistory,
    billing_agreement_id: 'gc-agreement',
  };
  const gcAgreement = {
    id: 'gc-agreement',
    tenant_id: 'tenant-1',
    member_id: 'member-1',
    organization_id: null,
    provider: 'gocardless',
    metadata: { dd: { invoicing_mode: 'per_instalment' } },
  };
  const unpaidDb = instalmentDb({
    histories: { member_membership_history: { 'history-1': gcHistory } },
    agreements: { 'gc-agreement': gcAgreement },
    plans: {
      'gc-agreement': [{
        id: 'gc-plan',
        tenant_id: 'tenant-1',
        billing_agreement_id: 'gc-agreement',
        member_id: 'member-1',
        organization_id: null,
        currency: 'GBP',
      }],
    },
    gcRows: [{
      id: 'gc-unpaid',
      tenant_id: 'tenant-1',
      plan_id: 'gc-plan',
      gocardless_payment_id: 'gc-payment-unpaid',
      amount_minor: 1000,
      currency: 'GBP',
      status: 'confirmed',
      accounting_provider: 'xero',
      accounting_sync_status: 'invoice_unpaid',
      accounting_sync_error: 'invoice created but payment not recorded \u0000 (check bank)',
      created_at: '2026-04-01T00:00:00Z',
    }],
  });
  const unpaidRes = response();
  await endpoint({ db: unpaidDb })({
    method: 'GET',
    query: { recordId: 'history-1', instalments: 'true' },
  }, unpaidRes);

  const unpaid = unpaidRes.payload.instalments[0];
  assert.equal(unpaid.accountingSyncState, 'invoice_unpaid');
  assert.equal(unpaid.missingProvider, false);
  assert.equal(
    unpaid.accountingSyncReason,
    'invoice created but payment not recorded (check bank)',
  );
  assert.equal(unpaid.syncError, 'invoice created but payment not recorded (check bank)');
});

test('returns an empty GC ledger explicitly when the owned plan has no collections', async () => {
  const history = {
    ...personalHistory,
    billing_agreement_id: 'gc-agreement',
  };
  const agreement = {
    id: 'gc-agreement',
    tenant_id: 'tenant-1',
    member_id: 'member-1',
    organization_id: null,
    provider: 'gocardless',
    metadata: { dd: { invoicing_mode: 'annual', membership_year: '2026/2027' } },
  };
  const db = instalmentDb({
    histories: { member_membership_history: { 'history-1': history } },
    agreements: { 'gc-agreement': agreement },
    plans: {
      'gc-agreement': [{
        id: 'gc-plan',
        tenant_id: 'tenant-1',
        billing_agreement_id: 'gc-agreement',
        member_id: 'member-1',
        organization_id: null,
        provider: 'gocardless',
        status: 'payment_setup_required',
        amount_minor: 1000,
        currency: 'GBP',
        instalments_total: 12,
        created_at: '2026-04-01T00:00:00Z',
      }],
    },
  });
  const res = response();

  await endpoint({ db })({
    method: 'GET',
    query: { recordId: 'history-1', instalments: 'true' },
  }, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.payload.ledger.state, 'empty');
  assert.equal(res.payload.ledger.missing, false);
  assert.equal(res.payload.planCollectedCount, 0);
  assert.deepEqual(res.payload.instalments, []);
});

test('does not disclose another member history or query its agreement ledger', async () => {
  const db = instalmentDb({
    histories: {
      member_membership_history: {
        'history-1': { ...personalHistory, member_id: 'different-member' },
      },
    },
  });
  const res = response();

  await endpoint({ db })({
    method: 'GET',
    query: { recordId: 'history-1', instalments: 'true' },
  }, res);

  assert.equal(res.statusCode, 403);
  assert.equal(db.calls.some((call) => call.table === 'membership_billing_agreements'), false);
  assert.equal(db.calls.some((call) => call.table === 'membership_payment_plans'), false);
});

test('requires a positive bounded page number', async () => {
  const db = instalmentDb();
  for (const page of ['0', '1.5', '1001', 'not-a-number']) {
    const res = response();
    await endpoint({ db })({
      method: 'GET',
      query: { recordId: 'history-1', instalments: 'true', page },
    }, res);
    assert.equal(res.statusCode, 400, page);
  }
  assert.equal(db.calls.length, 0);
});

test('an admin can read an organisation history row but still gets agreement ownership validation', async () => {
  const history = {
    id: 'org-history',
    tenant_id: 'tenant-1',
    member_id: null,
    organization_id: 'org-1',
    membership_year: '2026/2027',
    billing_period: 'monthly_direct_debit',
    billing_agreement_id: 'org-agreement',
  };
  const agreement = {
    id: 'org-agreement',
    tenant_id: 'tenant-1',
    member_id: null,
    organization_id: 'org-1',
    provider: 'gocardless',
    status: 'active',
    metadata: { dd: { invoicing_mode: 'per_instalment', instalment_count: 12 } },
  };
  const db = instalmentDb({
    histories: { organisation_membership_history: { 'org-history': history } },
    agreements: { 'org-agreement': agreement },
    plans: {
      'org-agreement': [{
        id: 'org-plan',
        tenant_id: 'tenant-1',
        billing_agreement_id: 'org-agreement',
        member_id: null,
        organization_id: 'org-1',
        provider: 'gocardless',
        instalments_total: 12,
        created_at: '2026-04-01T00:00:00Z',
      }],
    },
    gcRows: [{
      id: 'gc-row',
      tenant_id: 'tenant-1',
      plan_id: 'org-plan',
      gocardless_payment_id: 'PM-1',
      amount_minor: 1000,
      currency: 'GBP',
      status: 'confirmed',
      charge_date: '2026-04-02',
      confirmed_at: '2026-04-03T00:00:00Z',
      accounting_provider: 'xero',
      accounting_invoice_id: 'xero-gc-1',
      accounting_invoice_number: 'GC-001',
    }],
  });
  const res = response();

  await endpoint({ db, admin: true, sessionMember: null })({
    method: 'GET',
    query: { recordId: 'org-history', source: 'organisation', instalments: 'true' },
  }, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.payload.ledger.provider, 'gocardless');
  assert.equal(res.payload.planCollectedCount, 1);
  assert.equal(res.payload.instalments[0].paymentRef, 'PM-1');
});

test('selects only the owner column that exists on each history table', async () => {
  const personalDb = instalmentDb({
    histories: {
      member_membership_history: {
        'history-1': personalHistory,
      },
    },
    agreements: { 'agreement-1': stripeAgreement },
    stripeRows: [],
  });
  const personalRes = response();
  await endpoint({ db: personalDb })({
    method: 'GET',
    query: { recordId: 'history-1', instalments: 'true' },
  }, personalRes);
  assert.equal(personalRes.statusCode, 200);
  assert.match(
    personalDb.calls.find((call) => call.table === 'member_membership_history').selected,
    /member_id/,
  );
  assert.doesNotMatch(
    personalDb.calls.find((call) => call.table === 'member_membership_history').selected,
    /organization_id/,
  );

  const organisationDb = instalmentDb({
    histories: {
      organisation_membership_history: {
        'org-history': {
          id: 'org-history',
          tenant_id: 'tenant-1',
          organization_id: 'org-1',
          member_id: undefined,
          billing_agreement_id: null,
        },
      },
    },
  });
  const organisationRes = response();
  await endpoint({ db: organisationDb, admin: true, sessionMember: null })({
    method: 'GET',
    query: {
      recordId: 'org-history',
      source: 'organisation',
      instalments: 'true',
    },
  }, organisationRes);
  assert.equal(organisationRes.statusCode, 200);
  assert.match(
    organisationDb.calls.find((call) => call.table === 'organisation_membership_history').selected,
    /organization_id/,
  );
  assert.doesNotMatch(
    organisationDb.calls.find((call) => call.table === 'organisation_membership_history').selected,
    /member_id/,
  );
});

test('annual memberId reads reject same-tenant member IDORs before querying member data', async () => {
  const db = instalmentDb();
  const res = response();

  await endpoint({ db })({
    method: 'GET',
    query: { memberId: 'different-member' },
  }, res);

  assert.equal(res.statusCode, 403);
  assert.equal(db.calls.length, 0);
});

test('annual memberId reads fail closed for a tenant-mismatched session', async () => {
  const db = instalmentDb();
  const res = response();

  await endpoint({
    db,
    sessionMember: {
      id: 'member-1',
      tenant_id: 'tenant-2',
      organization_id: null,
      role_id: 'member-role',
    },
  })({
    method: 'GET',
    query: { memberId: 'member-1' },
  }, res);

  assert.equal(res.statusCode, 409);
  assert.equal(db.calls.length, 0);
});

test('annual memberId reads require an authenticated member or tenant admin', async () => {
  const db = instalmentDb();
  const res = response();

  await endpoint({ db, sessionMember: null })({
    method: 'GET',
    query: { memberId: 'member-1' },
  }, res);

  assert.equal(res.statusCode, 401);
  assert.equal(db.calls.length, 0);
});

test('instalment detail also rejects a tenant-mismatched session before history lookup', async () => {
  const db = instalmentDb();
  const res = response();

  await endpoint({
    db,
    sessionMember: {
      id: 'member-1',
      tenant_id: 'tenant-2',
      organization_id: null,
      role_id: 'member-role',
    },
  })({
    method: 'GET',
    query: { recordId: 'history-1', instalments: 'true' },
  }, res);

  assert.equal(res.statusCode, 409);
  assert.equal(db.calls.length, 0);
});
