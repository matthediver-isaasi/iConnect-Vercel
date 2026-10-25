import test from 'node:test';
import assert from 'node:assert/strict';
import { resolvedTicketValue, attachSalesTicketValues } from './salesTicketValue.js';
import { normalizeGroupPricePaid, normalizeGroupPayment, normalizeGroupTicketPrices } from '../reports/_pricePaid.js';
import { createAllocationValuesHandler } from '../sales/allocation-values.js';

test('pending value stays unknown in paid, ticket and aggregate reports', () => {
  const value = resolvedTicketValue({ gross_minor: null, net_minor: null, tax_minor: null }, null);
  const rows = [{ total_cost: 0, ticket_price: 0, total_paid: 0, _proposal_ticket_value: value }];
  assert.deepEqual(normalizeGroupPricePaid(rows), [{ price_paid: null, price_paid_status: 'proposal_pending' }]);
  assert.deepEqual(normalizeGroupTicketPrices(rows), [null]);
  assert.equal(normalizeGroupPayment(rows).ticketTotal, null);
  assert.equal(normalizeGroupPayment(rows).proposalAttributedTotal, null);
});
test('resolution apportions exact pennies and preserves immutable evidence', () => {
  const values = [1, 2, 3].map(place_index => resolvedTicketValue({ gross_minor: null, place_index },
    { places: 3, grossMinor: 10, netMinor: 8 }));
  assert.deepEqual(values.map(v => v.gross_minor), ['3', '3', '4']);
  assert.equal(values.reduce((s, v) => s + Number(v.net_minor), 0), 8);
  assert.equal(values.reduce((s, v) => s + Number(v.tax_minor), 0), 2);
  assert.equal(resolvedTicketValue({ gross_minor: null, place_index: 1 }, { places: 6, grossMinor: 0, netMinor: 0 }).gross_minor, '0');
});
test('report resolution reads are tenant scoped and existing attribution stays unchanged', async () => {
  const filters = [];
  const db = { from(table) {
    const data = table === 'sales_allocation_ticket_value'
      ? [{ booking_id: 'b', allocation_id: 'a', gross_minor: null, place_index: 1 }]
      : [{ allocation_id: 'a', snapshot: { places: 6, grossMinor: 72000, netMinor: 60000 } }];
    const q = { select() { return this; }, eq(...x) { filters.push([table, ...x]); return this; },
      in() { return this; }, then(fn) { return Promise.resolve({ data }).then(fn); } };
    return q;
  }};
  const rows = await attachSalesTicketValues(db, 'tenant', [{ id: 'b' }]);
  assert.equal(rows[0]._proposal_ticket_value.gross_minor, '12000');
  assert.ok(filters.some(f => f.join() === 'sales_allocation_value_resolution,tenant_id,tenant'));
});
test('member allocation managers cannot read or assign commercial values', async () => {
  const handler = createAllocationValuesHandler({
    db: { from() { throw new Error('Must not access DB'); } },
    getTenantContext: async () => ({ isAuthenticated: true, tenantId: 't', memberId: 'm', roleId: 'r' }),
    hasFeatureAccess: async () => true,
  });
  for (const method of ['GET', 'POST']) {
    let status;
    await handler({ method }, { setHeader() {}, status(s) { status = s; return this; }, json() {} });
    assert.equal(status, 403);
  }
});

test('admin assignment passes only validated values and server-owned tenant/actor to the RPC', async () => {
  const id = '11111111-1111-4111-8111-111111111111';
  const key = '22222222-2222-4222-8222-222222222222';
  const calls = [];
  const snapshot = { status: 'allocated', currency: 'GBP', netMinor: 60000, taxMinor: 12000, lineNetMinor: 400000, lineTaxMinor: 80000 };
  const db = {
    from() {
      return { select() { return this; }, eq(...args) { calls.push(args); return this; },
        async maybeSingle() { return { data: { id, allocated_places: 6, proposal_value_snapshot: { status: 'pending' } } }; } };
    },
    async rpc(name, params) { calls.push({ name, params }); return { data: snapshot }; },
  };
  const handler = createAllocationValuesHandler({ db, getTenantContext: async () => ({
    isAuthenticated: true, tenantId: 'server-tenant', tenantUserId: 'server-actor',
  }) });
  let body, status = 200;
  const res = { setHeader() {}, status(s) { status = s; return this; }, json(value) { body = value; } };
  await handler({ method: 'POST', body: { allocationId: id, netMinor: 60000, reason: ' Tickets ', idempotencyKey: key, tenantId: 'hostile', actorId: 'hostile' } }, res);
  assert.equal(status, 200);
  assert.equal(body.status, 'allocated');
  assert.equal(body.taxMinor, 12000);
  assert.ok(calls.some(c => Array.isArray(c) && c[0] === 'tenant_id' && c[1] === 'server-tenant'));
  assert.deepEqual(calls.at(-1), { name: 'resolve_sales_allocation_value', params: {
    p_tenant_id: 'server-tenant', p_allocation_id: id, p_actor_id: 'server-actor',
    p_net_minor: 60000, p_reason: 'Tickets', p_idempotency_key: key,
  } });
  for (const netMinor of [-1, 0.5, '60000', Number.MAX_SAFE_INTEGER + 1]) {
    await handler({ method: 'POST', body: { allocationId: id, netMinor, reason: 'Tickets', idempotencyKey: key } }, res);
    assert.equal(status, 400);
  }
});
