import test from 'node:test';
import assert from 'node:assert/strict';
import {
  looksLikePoReference,
  extractPoFromReference,
  resolvePoCandidate,
  isPlaceholderPoValue,
  buildMembershipPoMaps,
  findMembershipPoForRecord,
  isPendingMembershipPoRow,
  computePendingPoInvoices,
  applyInvoicePoUpdate,
  prepareReminderForInvoice,
} from './pendingPoInvoice.js';

function createPendingPoClient({
  organizations = [{ id: 'org-1', name: 'Example Org' }],
  members = [{ id: 'member-1', organization_id: 'org-1', email: 'member@example.org' }],
  groups = [],
  bookings = [],
  transactions = [],
  lookupError = null,
  strictFilters = false,
  organisationMembershipHistory = [],
  memberMembershipHistory = [],
  organisationMembershipInvoicing = [],
  memberMembershipInvoicing = [],
  tenants = [{ id: 'tenant-1', name: 'Example Tenant', slug: 'example', primary_color: '#123456' }],
} = {}) {
  const calls = [];
  const rowsByTable = {
    organization: organizations,
    member: members,
    organization_group: groups,
    booking: bookings,
    program_ticket_transaction: transactions,
    training_fund_purchase: [],
    event: [],
    organisation_membership_history: organisationMembershipHistory,
    member_membership_history: memberMembershipHistory,
    organisation_membership_invoicing: organisationMembershipInvoicing,
    member_membership_invoicing: memberMembershipInvoicing,
    tenant: tenants,
    pending_po_token: [],
  };

  const execute = (query) => {
    let rows = rowsByTable[query.table] || [];
    if (lookupError?.table === query.table && (!lookupError.from || query.from >= lookupError.from)) {
      return { data: null, error: { message: 'Lookup unavailable' } };
    }
    if (strictFilters) {
      rows = rows.filter((row) => query.filters.every(({ method, column, value }) => {
        if (method === 'eq') return row[column] === value;
        if (method === 'in') return value.includes(row[column]);
        if (method === 'is') return (row[column] ?? null) === value;
        if (method === 'neq') return row[column] !== value;
        return true;
      }));
    }
    if (query.operation === 'update') {
      calls.push({
        operation: 'update',
        table: query.table,
        values: query.updateValues,
        filters: query.filters,
      });
      return { data: rows.map((row) => ({ id: row.id })), error: null };
    }
    if (query.operation === 'insert') {
      calls.push({
        operation: 'insert',
        table: query.table,
        values: query.insertValues,
        filters: query.filters,
      });
      return { data: query.insertValues, error: null };
    }

    // The compute path performs a second membership-history lookup for rows
    // that already carry a PO. Keep those propagation lookups separate from
    // the initial pending-membership source query.
    if (
      ['organisation_membership_history', 'member_membership_history'].includes(query.table)
      && query.filters.some((filter) => filter.method === 'not' && filter.column === 'purchase_order_number')
    ) {
      return { data: [], error: null };
    }

    calls.push({
      operation: 'select',
      table: query.table,
      columns: query.columns,
      filters: query.filters,
      from: query.from,
    });
    return { data: query.from == null ? rows : rows.slice(query.from, query.to + 1), error: null };
  };

  class Query {
    constructor(table) {
      this.table = table;
      this.operation = 'select';
      this.columns = null;
      this.updateValues = null;
      this.insertValues = null;
      this.filters = [];
    }

    select(columns) {
      this.columns = columns;
      return this;
    }

    update(values) {
      this.operation = 'update';
      this.updateValues = values;
      return this;
    }

    insert(values) {
      this.operation = 'insert';
      this.insertValues = values;
      return this;
    }

    eq(column, value) {
      this.filters.push({ method: 'eq', column, value });
      return this;
    }

    neq(column, value) {
      this.filters.push({ method: 'neq', column, value });
      return this;
    }

    in(column, value) {
      this.filters.push({ method: 'in', column, value });
      return this;
    }

    is(column, value) {
      this.filters.push({ method: 'is', column, value });
      return this;
    }

    not(column, operator, value) {
      this.filters.push({ method: 'not', column, operator, value });
      return this;
    }

    or(value) {
      this.filters.push({ method: 'or', value });
      return this;
    }

    order() {
      return this;
    }

    limit() {
      return this;
    }

    single() {
      const result = execute(this);
      return Promise.resolve({
        ...result,
        data: Array.isArray(result.data) ? (result.data[0] || null) : result.data,
      });
    }

    range(from, to) {
      this.from = from;
      this.to = to;
      return Promise.resolve(execute(this));
    }

    then(resolve, reject) {
      return Promise.resolve(execute(this)).then(resolve, reject);
    }
  }

  return {
    calls,
    from(table) {
      return new Query(table);
    },
  };
}

test('extractPoFromReference extracts PO from our membership reference convention', () => {
  assert.equal(extractPoFromReference('Membership 2025/2026 - PO: test2407'), 'test2407');
  assert.equal(extractPoFromReference('Membership 2026/27 - PO: PO-00123'), 'PO-00123');
  assert.equal(extractPoFromReference('PO: ABC123'), 'ABC123');
});

const displayBooking = (id, memberId, organizationId = null, invoice = id) => ({
  id, member_id: memberId, organization_id: organizationId,
  xero_invoice_number: invoice, payment_method: 'account',
  purchase_order_number: null, status: 'active', ticket_price: 25,
});
const tenantRow = (row) => ({ tenant_id: 'tenant-1', ...row });
const bedfordshire = 'Bedfordshire Hospitals NHS Foundation Trust';

test('compute display uses member organisation, then direct group, then exact unknown without changing ownership', async () => {
  const client = createPendingPoClient({
    strictFilters: true,
    organizations: [
      tenantRow({ id: 'billing', name: 'Billing Organisation' }),
      tenantRow({ id: 'member-org', name: 'Member Organisation' }),
    ],
    groups: [tenantRow({ id: 'trust', name: bedfordshire })],
    members: [
      tenantRow({ id: 'kathryn', organization_id: null, organization_group_id: 'trust', first_name: 'Kathryn' }),
      tenantRow({ id: 'both', organization_id: 'member-org', organization_group_id: 'trust' }),
      tenantRow({ id: 'neither', organization_id: null, organization_group_id: null, first_name: 'Individual' }),
    ],
    bookings: [
      displayBooking('group', 'kathryn'),
      displayBooking('both', 'both', 'billing'),
      displayBooking('neither', 'neither'),
      displayBooking('billing', null, 'billing'),
    ],
  });
  const result = await computePendingPoInvoices({ client, tenantId: 'tenant-1' });
  const byId = Object.fromEntries(result.records.map((r) => [r.id, r]));
  assert.equal(byId['num:group'].organization_display_name, bedfordshire);
  assert.equal(byId['num:group'].organization_id, null);
  assert.equal(byId['num:both'].organization_display_name, 'Member Organisation');
  assert.equal(byId['num:both'].organization_id, 'billing');
  assert.equal(byId['num:neither'].organization_display_name, 'Unknown Organisation');
  assert.equal(byId['num:billing'].organization_display_name, 'Billing Organisation');
  assert.equal(byId['num:billing'].organization_id, 'billing');
  assert.equal(client.calls.some((c) => c.operation !== 'select'), false);
  for (const table of ['member', 'organization', 'organization_group']) {
    assert.ok(client.calls.filter((c) => c.table === table).every((c) =>
      c.filters.some((f) => f.method === 'eq' && f.column === 'tenant_id' && f.value === 'tenant-1')));
  }
});

test('compute display lookup failures and unresolved tenant associations fail rather than become unknown', async () => {
  for (const table of ['member', 'organization', 'organization_group']) {
    const client = createPendingPoClient({
      members: [{ id: 'm', organization_group_id: 'g' }],
      lookupError: { table },
    });
    await assert.rejects(computePendingPoInvoices({ client, tenantId: 'tenant-1' }), /Lookup unavailable/);
  }
  for (const member of [
    tenantRow({ id: 'm', organization_id: 'missing' }),
    tenantRow({ id: 'm', organization_group_id: 'missing' }),
    tenantRow({ id: 'other' }),
  ]) {
    const client = createPendingPoClient({
      strictFilters: true,
      organizations: [tenantRow({ id: 'billing', name: 'Billing' })],
      members: [member],
      bookings: [displayBooking('broken', 'm', 'billing')],
    });
    await assert.rejects(computePendingPoInvoices({ client, tenantId: 'tenant-1' }), /Failed to resolve/);
  }
});

test('transaction billing organisation cannot be reclassified by a matching member email', async () => {
  const client = createPendingPoClient({
    strictFilters: true,
    organizations: [
      tenantRow({ id: 'billing', name: 'Authoritative Billing Organisation' }),
      tenantRow({ id: 'member-org', name: 'Unrelated Member Organisation' }),
    ],
    members: [tenantRow({
      id: 'member', organization_id: 'member-org', email: 'matching@example.org',
    })],
    transactions: [{
      id: 'transaction', organization_id: 'billing', member_email: 'matching@example.org',
      transaction_type: 'purchase', status: 'active', purchase_order_number: null,
      xero_invoice_number: 'BILLING-ONLY', quantity: 1, total_cost_before_discount: 50,
    }],
  });
  const { records } = await computePendingPoInvoices({ client, tenantId: 'tenant-1' });
  assert.equal(records.length, 1);
  assert.equal(records[0].organization_display_name, 'Authoritative Billing Organisation');
  assert.equal(records[0].organization_id, 'billing');
  assert.equal(records[0].member_email, 'matching@example.org');
});

test('compute display fully paginates member and organisation lookups and chunks direct group lookups', async () => {
  const organizations = Array.from({ length: 1001 }, (_, i) => tenantRow({ id: `o${i}`, name: `Org ${i}` }));
  const members = Array.from({ length: 1001 }, (_, i) => tenantRow({
    id: `m${i}`, organization_id: i === 1000 ? 'o1000' : null,
    organization_group_id: i === 1000 ? null : `g${i}`,
  }));
  const client = createPendingPoClient({
    strictFilters: true, organizations, members,
    groups: members.slice(0, 1000).map((m, i) => tenantRow({ id: `g${i}`, name: `Group ${i}` })),
    bookings: [displayBooking('late-org', 'm1000'), displayBooking('late-group', 'm999')],
  });
  const result = await computePendingPoInvoices({ client, tenantId: 'tenant-1' });
  assert.equal(result.records.find((r) => r.id === 'num:late-org').organization_display_name, 'Org 1000');
  assert.equal(result.records.find((r) => r.id === 'num:late-group').organization_display_name, 'Group 999');
  for (const table of ['member', 'organization']) {
    assert.ok(client.calls.some((c) => c.table === table && c.from === 1000));
  }
  const groupCalls = client.calls.filter((c) => c.table === 'organization_group');
  assert.equal(groupCalls.length, 2);
  assert.ok(groupCalls.every((c) => c.filters.find((f) => f.method === 'in').value.length <= 500));
  const failing = createPendingPoClient({ organizations, lookupError: { table: 'organization', from: 1000 } });
  await assert.rejects(computePendingPoInvoices({ client: failing, tenantId: 'tenant-1' }), /Lookup unavailable/);
});

test('consolidation displays all distinct associations deterministically, including genuine unknowns', async () => {
  const bookings = [
    displayBooking('a', 'unknown', null, 'shared'),
    displayBooking('b', 'group', null, 'shared'),
    displayBooking('c', 'org', null, 'shared'),
    displayBooking('d', 'group', null, 'shared'),
  ];
  for (const ordered of [bookings, [...bookings].reverse()]) {
    const client = createPendingPoClient({
      strictFilters: true,
      organizations: [tenantRow({ id: 'org', name: 'Member Organisation' })],
      members: [
        tenantRow({ id: 'unknown' }),
        tenantRow({ id: 'group', organization_group_id: 'trust' }),
        tenantRow({ id: 'org', organization_id: 'org' }),
      ],
      groups: [tenantRow({ id: 'trust', name: bedfordshire })],
      bookings: ordered,
    });
    const { records } = await computePendingPoInvoices({ client, tenantId: 'tenant-1' });
    assert.equal(records.length, 1);
    assert.equal(records[0].organization_display_name, `${bedfordshire}; Member Organisation; Unknown Organisation`);
    assert.equal(records[0].quantity, 4);
    assert.equal(records[0].total_cost, 100);
  }
});

test('extractPoFromReference rejects placeholder junk values', () => {
  assert.equal(extractPoFromReference('Membership 2025/2026 - PO: TBC'), null);
  assert.equal(extractPoFromReference('PO: TBC'), null);
  assert.equal(extractPoFromReference('PO: n/a'), null);
  assert.equal(extractPoFromReference('PO: pending'), null);
  assert.equal(extractPoFromReference('PO: '), null);
  assert.equal(extractPoFromReference('PO: -'), null);
});

test('extractPoFromReference returns null for purely descriptive references', () => {
  assert.equal(extractPoFromReference('Membership 2025/2026'), null);
  assert.equal(extractPoFromReference('Training Fund top-up'), null);
  assert.equal(extractPoFromReference(''), null);
  assert.equal(extractPoFromReference(null), null);
});

test('looksLikePoReference still rejects descriptive/placeholder references', () => {
  assert.equal(looksLikePoReference('Membership 2025/2026'), false);
  assert.equal(looksLikePoReference('Membership 2025/2026 - PO: test2407'), false);
  assert.equal(looksLikePoReference('Training Fund top-up'), false);
  assert.equal(looksLikePoReference('TBC'), false);
  assert.equal(looksLikePoReference('PO12345'), true);
});

test('resolvePoCandidate prefers a real PO value and falls back to embedded extraction', () => {
  assert.equal(resolvePoCandidate('PO9999', 'Membership 2025/2026'), 'PO9999');
  assert.equal(resolvePoCandidate(null, 'Membership 2025/2026 - PO: test2407'), 'test2407');
  assert.equal(resolvePoCandidate('', 'Membership 2025/2026'), null);
  assert.equal(resolvePoCandidate(null, 'Training Fund top-up'), null);
  assert.equal(resolvePoCandidate(null, 'PO: TBC'), null);
});

test('isPlaceholderPoValue', () => {
  assert.equal(isPlaceholderPoValue('TBC'), true);
  assert.equal(isPlaceholderPoValue(' n/a '), true);
  assert.equal(isPlaceholderPoValue('test2407'), false);
});

test('membership-row PO propagates to a sibling training fund row on the same invoice', () => {
  const historyRows = [{
    id: 'h1',
    purchase_order_number: 'test2407',
    xero_invoice_id: 'inv-uuid-1',
    xero_invoice_number: 'SI-44584',
    accounting_invoice_id: 'inv-uuid-1',
    accounting_invoice_number: 'SI-44584',
  }];
  const maps = buildMembershipPoMaps(historyRows);
  const tfRecord = {
    entityType: 'training_fund_purchase',
    xero_invoice_id: 'inv-uuid-1',
    xero_invoice_number: 'SI-44584',
  };
  assert.equal(findMembershipPoForRecord(tfRecord, maps), 'test2407');
  // Match by accounting_* columns too (QBO dual-column gotcha).
  const qboRecord = {
    entityType: 'training_fund_purchase',
    xero_invoice_id: null,
    accounting_invoice_id: 'inv-uuid-1',
  };
  assert.equal(findMembershipPoForRecord(qboRecord, maps), 'test2407');
  // Match by invoice number when ids are absent.
  const numRecord = { entityType: 'booking', xero_invoice_number: 'SI-44584' };
  assert.equal(findMembershipPoForRecord(numRecord, maps), 'test2407');
});

test('regression: top-up with descriptive reference and no PO anywhere stays visible', () => {
  // No membership row carries a PO for this invoice.
  const maps = buildMembershipPoMaps([{
    id: 'h2',
    purchase_order_number: null,
    xero_invoice_id: 'inv-uuid-2',
    xero_invoice_number: 'SI-99999',
  }]);
  const tfRecord = {
    entityType: 'training_fund_purchase',
    xero_invoice_id: 'inv-uuid-2',
    xero_invoice_number: 'SI-99999',
  };
  assert.equal(findMembershipPoForRecord(tfRecord, maps), null);
  // And the Xero reference path also keeps it visible.
  assert.equal(resolvePoCandidate(null, 'Training Fund top-up'), null);
});

test('placeholder PO on a membership row never propagates', () => {
  const maps = buildMembershipPoMaps([{
    id: 'h3',
    purchase_order_number: 'TBC',
    xero_invoice_id: 'inv-uuid-3',
  }]);
  assert.equal(findMembershipPoForRecord({ xero_invoice_id: 'inv-uuid-3' }, maps), null);
});

test('records with no matching invoice keys are untouched', () => {
  const maps = buildMembershipPoMaps([{
    id: 'h4',
    purchase_order_number: 'PO777',
    xero_invoice_id: 'inv-uuid-4',
  }]);
  assert.equal(findMembershipPoForRecord({ xero_invoice_id: 'other' }, maps), null);
  assert.equal(findMembershipPoForRecord({}, maps), null);
});

test('membership pending-PO eligibility requires unpaid, active, invoice-linked rows without a genuine PO', () => {
  const base = {
    id: 'history-1',
    status: 'active',
    payment_status: 'unpaid',
    accounting_invoice_id: 'invoice-1',
    purchase_order_number: null,
  };
  assert.equal(isPendingMembershipPoRow(base), true);
  assert.equal(isPendingMembershipPoRow({ ...base, payment_status: null }), true);
  assert.equal(isPendingMembershipPoRow({ ...base, purchase_order_number: 'TBC' }), true);
  assert.equal(isPendingMembershipPoRow({ ...base, purchase_order_number: 'PO-123' }), false);
  assert.equal(isPendingMembershipPoRow({ ...base, payment_status: 'paid' }), false);
  assert.equal(isPendingMembershipPoRow({ ...base, status: 'cancelled' }), false);
  assert.equal(isPendingMembershipPoRow({ ...base, accounting_invoice_id: null }), false);
});

test('computePendingPoInvoices includes organisation and member membership-only invoices and excludes genuine POs', async () => {
  const client = createPendingPoClient({
    organisationMembershipHistory: [
      {
        id: 'org-history-pending',
        tenant_id: 'tenant-1',
        organization_id: 'org-1',
        membership_year: '2026/2027',
        status: 'active',
        payment_status: null,
        final_cost: 100,
        total_with_vat: 120,
        created_at: '2026-08-01T00:00:00.000Z',
        purchase_order_number: null,
        accounting_invoice_id: 'accounting-org-1',
        accounting_invoice_number: 'QBO-ORG-1',
      },
      {
        id: 'org-history-has-po',
        tenant_id: 'tenant-1',
        organization_id: 'org-1',
        membership_year: '2025/2026',
        status: 'active',
        payment_status: 'unpaid',
        final_cost: 80,
        created_at: '2026-07-01T00:00:00.000Z',
        purchase_order_number: 'PO-EXISTING',
        accounting_invoice_id: 'accounting-org-2',
        accounting_invoice_number: 'QBO-ORG-2',
      },
      {
        id: 'org-history-paid',
        tenant_id: 'tenant-1',
        organization_id: 'org-1',
        membership_year: '2024/2025',
        status: 'active',
        payment_status: 'paid',
        final_cost: 70,
        created_at: '2026-06-01T00:00:00.000Z',
        purchase_order_number: null,
        accounting_invoice_id: 'accounting-org-paid',
        accounting_invoice_number: 'QBO-ORG-PAID',
      },
    ],
    memberMembershipHistory: [{
      id: 'member-history-pending',
      tenant_id: 'tenant-1',
      member_id: 'member-1',
      membership_year: '2026/2027',
      status: 'active',
      payment_status: 'unpaid',
      final_cost: 50,
      total_with_vat: 60,
      created_at: '2026-08-02T00:00:00.000Z',
      purchase_order_number: null,
      accounting_invoice_id: 'accounting-member-1',
      accounting_invoice_number: 'QBO-MEMBER-1',
    }],
  });

  const result = await computePendingPoInvoices({ client, tenantId: 'tenant-1' });

  assert.equal(result.records.length, 2);
  const orgInvoice = result.records.find((record) => record.id === 'id:accounting-org-1');
  assert.equal(orgInvoice.source_type, 'Membership');
  assert.equal(orgInvoice.source_name, 'Membership 2026/2027');
  assert.equal(orgInvoice.organization_id, 'org-1');
  assert.equal(orgInvoice.total_cost, 120);

  const memberInvoice = result.records.find((record) => record.id === 'id:accounting-member-1');
  assert.equal(memberInvoice.organization_id, 'org-1');
  assert.equal(memberInvoice.member_email, 'member@example.org');
  assert.equal(memberInvoice.total_cost, 60);
  assert.equal(result.records.some((record) => record.id === 'id:accounting-org-2'), false);
  assert.equal(result.records.some((record) => record.id === 'id:accounting-org-paid'), false);

  const orgHistoryQuery = client.calls.find(
    (call) => call.operation === 'select' && call.table === 'organisation_membership_history',
  );
  assert.ok(orgHistoryQuery.filters.some(
    (filter) => filter.method === 'eq' && filter.column === 'tenant_id' && filter.value === 'tenant-1',
  ));
  assert.ok(orgHistoryQuery.filters.some(
    (filter) => filter.method === 'or'
      && filter.value === 'payment_status.eq.unpaid,payment_status.is.null',
  ));
});

test('applyInvoicePoUpdate updates membership history and matching invoicing state', async () => {
  const client = createPendingPoClient({
    organisationMembershipHistory: [{
      id: 'org-history-1',
      tenant_id: 'tenant-1',
      organization_id: 'org-1',
      membership_year: '2026/2027',
      status: 'active',
      payment_status: null,
      purchase_order_number: null,
      accounting_invoice_number: 'QBO-100',
    }],
    organisationMembershipInvoicing: [{ id: 'org-invoicing-1' }],
  });

  const result = await applyInvoicePoUpdate({
    client,
    tenantId: 'tenant-1',
    invoiceKey: 'num:QBO-100',
    purchaseOrderNumber: ' PO-100 ',
  });

  assert.equal(result.ok, true);
  assert.equal(result.organisationMembershipHistoryUpdated, 1);
  assert.equal(result.membershipInvoicingUpdated, 1);
  assert.equal(result.xeroUpdated, false);

  const historyUpdate = client.calls.find(
    (call) => call.operation === 'update' && call.table === 'organisation_membership_history',
  );
  assert.deepEqual(historyUpdate.values, { purchase_order_number: 'PO-100' });
  assert.ok(historyUpdate.filters.some(
    (filter) => filter.method === 'eq' && filter.column === 'tenant_id' && filter.value === 'tenant-1',
  ));
  const historySelect = client.calls.find(
    (call) => call.operation === 'select' && call.table === 'organisation_membership_history',
  );
  assert.ok(historySelect.filters.some(
    (filter) => filter.method === 'or'
      && filter.value === 'payment_status.eq.unpaid,payment_status.is.null',
  ));

  const invoicingUpdate = client.calls.find(
    (call) => call.operation === 'update' && call.table === 'organisation_membership_invoicing',
  );
  assert.deepEqual(invoicingUpdate.values, { purchase_order_number: 'PO-100' });
  assert.ok(invoicingUpdate.filters.some(
    (filter) => filter.method === 'eq' && filter.column === 'membership_year' && filter.value === '2026/2027',
  ));
});

test('membership rows sharing one provider invoice consolidate without losing member contact context', async () => {
  const client = createPendingPoClient({
    organisationMembershipHistory: [{
      id: 'org-history-shared',
      tenant_id: 'tenant-1',
      organization_id: 'org-1',
      membership_year: '2026/2027',
      status: 'active',
      payment_status: null,
      total_with_vat: 120,
      created_at: '2026-08-01T00:00:00.000Z',
      purchase_order_number: null,
      accounting_invoice_id: 'accounting-shared',
      accounting_invoice_number: 'QBO-SHARED',
    }],
    memberMembershipHistory: [{
      id: 'member-history-shared',
      tenant_id: 'tenant-1',
      member_id: 'member-1',
      membership_year: '2026/2027',
      status: 'active',
      payment_status: null,
      total_with_vat: 60,
      created_at: '2026-08-02T00:00:00.000Z',
      purchase_order_number: null,
      accounting_invoice_id: 'accounting-shared',
      accounting_invoice_number: 'QBO-SHARED',
    }],
  });

  const result = await computePendingPoInvoices({ client, tenantId: 'tenant-1' });

  assert.equal(result.records.length, 1);
  assert.equal(result.records[0].id, 'id:accounting-shared');
  assert.equal(result.records[0].quantity, 2);
  assert.equal(result.records[0].total_cost, 180);
  assert.equal(result.records[0].member_email, null);
  assert.equal(result.records[0].attendees.some((item) => item.email === 'member@example.org'), true);
});

test('applyInvoicePoUpdate supports member membership history and invoicing rows', async () => {
  const client = createPendingPoClient({
    memberMembershipHistory: [{
      id: 'member-history-1',
      tenant_id: 'tenant-1',
      member_id: 'member-1',
      membership_year: '2026/2027',
      status: 'active',
      payment_status: null,
      purchase_order_number: null,
      accounting_invoice_number: 'QBO-MEMBER-100',
    }],
    memberMembershipInvoicing: [{ id: 'member-invoicing-1' }],
  });

  const result = await applyInvoicePoUpdate({
    client,
    tenantId: 'tenant-1',
    invoiceKey: 'num:QBO-MEMBER-100',
    purchaseOrderNumber: 'PO-MEMBER-100',
  });

  assert.equal(result.ok, true);
  assert.equal(result.memberMembershipHistoryUpdated, 1);
  assert.equal(result.membershipInvoicingUpdated, 1);
  const historyUpdate = client.calls.find(
    (call) => call.operation === 'update' && call.table === 'member_membership_history',
  );
  assert.ok(historyUpdate);
  const historySelect = client.calls.find(
    (call) => call.operation === 'select' && call.table === 'member_membership_history',
  );
  assert.ok(historySelect.filters.some(
    (filter) => filter.method === 'or'
      && filter.value === 'payment_status.eq.unpaid,payment_status.is.null',
  ));
  const invoicingUpdate = client.calls.find(
    (call) => call.operation === 'update' && call.table === 'member_membership_invoicing',
  );
  assert.ok(invoicingUpdate.filters.some(
    (filter) => filter.method === 'eq' && filter.column === 'member_id' && filter.value === 'member-1',
  ));
});

test('organisation-less tenant member membership invoices remain visible and reminder-capable', async () => {
  const client = createPendingPoClient({
    organizations: [],
    members: [{
      id: 'individual-member-1',
      tenant_id: 'tenant-1',
      organization_id: null,
      email: 'individual@example.org',
      first_name: 'Individual',
      last_name: 'Member',
    }],
    memberMembershipHistory: [{
      id: 'individual-history-1',
      tenant_id: 'tenant-1',
      member_id: 'individual-member-1',
      membership_year: '2026/2027',
      status: 'active',
      payment_status: null,
      total_with_vat: 72,
      created_at: '2026-08-03T00:00:00.000Z',
      purchase_order_number: null,
      accounting_invoice_id: 'accounting-individual-1',
      accounting_invoice_number: 'QBO-INDIVIDUAL-1',
    }],
  });

  const computed = await computePendingPoInvoices({ client, tenantId: 'tenant-1' });
  assert.equal(computed.records.length, 1);
  assert.equal(computed.records[0].organization_id, null);
  assert.equal(computed.records[0].organization_display_name, 'Unknown Organisation');
  assert.equal(computed.records[0].member_email, 'individual@example.org');

  const prepared = await prepareReminderForInvoice({
    client,
    tenantId: 'tenant-1',
    invoiceKey: 'id:accounting-individual-1',
  });
  assert.equal(prepared.ok, true);
  assert.equal(prepared.recipientEmail, 'individual@example.org');
  assert.match(prepared.subject, /QBO-INDIVIDUAL-1/);
  assert.ok(client.calls.some(
    (call) => call.operation === 'insert' && call.table === 'pending_po_token',
  ));

  const tenantMemberQuery = client.calls.find(
    (call) => call.operation === 'select'
      && call.table === 'member'
      && call.filters.some((filter) => filter.column === 'tenant_id'),
  );
  assert.ok(tenantMemberQuery.filters.some(
    (filter) => filter.method === 'eq' && filter.column === 'tenant_id' && filter.value === 'tenant-1',
  ));
  const memberHistoryQueries = client.calls.filter(
    (call) => call.operation === 'select' && call.table === 'member_membership_history',
  );
  assert.ok(memberHistoryQueries.length >= 2);
  assert.ok(memberHistoryQueries.every((call) => call.filters.some(
    (filter) => filter.method === 'or'
      && filter.value === 'payment_status.eq.unpaid,payment_status.is.null',
  )));
});
