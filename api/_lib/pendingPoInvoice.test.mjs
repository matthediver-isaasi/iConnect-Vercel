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
    booking: [],
    program_ticket_transaction: [],
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
    const rows = rowsByTable[query.table] || [];
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
    });
    return { data: rows, error: null };
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

    range() {
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
        payment_status: 'unpaid',
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

  const orgHistoryQuery = client.calls.find(
    (call) => call.operation === 'select' && call.table === 'organisation_membership_history',
  );
  assert.ok(orgHistoryQuery.filters.some(
    (filter) => filter.method === 'eq' && filter.column === 'tenant_id' && filter.value === 'tenant-1',
  ));
  assert.ok(orgHistoryQuery.filters.some(
    (filter) => filter.method === 'eq' && filter.column === 'payment_status' && filter.value === 'unpaid',
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
      payment_status: 'unpaid',
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
      payment_status: 'unpaid',
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
      payment_status: 'unpaid',
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
      payment_status: 'unpaid',
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
      payment_status: 'unpaid',
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
});
