import assert from 'node:assert/strict';
import test from 'node:test';
import { mergeTicketCommercialCapacity } from './eventCommercialCapacity.js';
import {
  confirmQuoteSale,
  validateAllocationInput,
} from './salesCommercialAllocation.js';
import { createSalesAllocationsHandler } from '../sales/allocations/[...path].js';
import { createSalesQuotesHandler } from '../sales/quotes/[...path].js';

const tenantId = '00000000-0000-4000-8000-000000000001';
const actorId = '10000000-0000-4000-8000-000000000001';
const quoteId = '20000000-0000-4000-8000-000000000001';
const allocationId = '30000000-0000-4000-8000-000000000001';

function response() {
  return {
    statusCode: 0,
    body: null,
    headers: {},
    setHeader(name, value) { this.headers[name] = value; },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

const getTenantContext = async () => ({
  isAuthenticated: true,
  tenantId,
  tenantUserId: actorId,
});

test('quote sale confirmation forwards tenant, actor, concurrency, and idempotency boundaries', async () => {
  const calls = [];
  const db = {
    async rpc(name, args) {
      calls.push([name, args]);
      return { data: { saleId: 'sale-1', idempotent: false }, error: null };
    },
  };
  const result = await confirmQuoteSale(
    db,
    tenantId,
    { actorType: 'tenant_user', actorId },
    quoteId,
    { expectedVersion: 4, idempotencyKey: 'accept-4' },
  );
  assert.equal(result.saleId, 'sale-1');
  assert.deepEqual(calls, [[
    'confirm_sales_quote_sale',
    {
      p_tenant_id: tenantId,
      p_quote_id: quoteId,
      p_expected_version: 4,
      p_idempotency_key: 'accept-4',
      p_actor_kind: 'tenant_user',
      p_actor_id: actorId,
    },
  ]]);
});

test('quote confirm-sale route requires complete transaction tokens', async () => {
  const calls = [];
  const db = {
    async rpc(name, args) {
      calls.push([name, args]);
      return { data: { saleId: 'sale-1' }, error: null };
    },
  };
  const handler = createSalesQuotesHandler({ db, getTenantContext });
  const badRes = response();
  await handler({
    method: 'POST',
    query: { path: [quoteId, 'confirm-sale'] },
    body: { expectedVersion: 1 },
  }, badRes);
  assert.equal(badRes.statusCode, 400);
  assert.match(badRes.body.error, /idempotencyKey/);

  const okRes = response();
  await handler({
    method: 'POST',
    query: { path: [quoteId, 'confirm-sale'] },
    body: { expectedVersion: 1, idempotencyKey: 'sale-once' },
  }, okRes);
  assert.equal(okRes.statusCode, 201);
  assert.equal(calls[0][0], 'confirm_sales_quote_sale');
});

test('allocation lifecycle route validates movements and invokes the bounded RPC', async () => {
  const calls = [];
  const db = {
    async rpc(name, args) {
      calls.push([name, args]);
      return { data: { movementId: 'move-1' }, error: null };
    },
  };
  const handler = createSalesAllocationsHandler({ db, getTenantContext });
  const invalidRes = response();
  await handler({
    method: 'POST',
    query: { path: [allocationId, 'release'] },
    body: { places: 0, idempotencyKey: '' },
  }, invalidRes);
  assert.equal(invalidRes.statusCode, 400);
  assert.equal(calls.length, 0);

  const okRes = response();
  await handler({
    method: 'POST',
    query: { path: [allocationId, 'cancel'] },
    body: { places: 2, idempotencyKey: 'cancel-2', reason: 'Customer reduced order' },
  }, okRes);
  assert.equal(okRes.statusCode, 200);
  assert.equal(calls[0][0], 'cancel_sales_commercial_allocation');
  assert.equal(calls[0][1].p_places, 2);
});

test('allocation reconciliation input is explicit about booking kind and designation', () => {
  assert.deepEqual(validateAllocationInput({
    places: 1,
    idempotencyKey: 'delegate-1',
    bookingKind: 'complex',
    bookingId: 'booking-1',
    designation: 'named',
  }, { reconcile: true }), []);
  assert.equal(validateAllocationInput({
    places: 1,
    idempotencyKey: 'delegate-1',
    bookingKind: 'other',
    bookingId: '',
    designation: 'unknown',
  }, { reconcile: true }).length, 3);
  assert.deepEqual(validateAllocationInput({
    places: 2,
    idempotencyKey: 'delegate-group',
    bookingKind: 'complex',
    bookingId: 'booking-2',
    designation: 'named',
  }, { reconcile: true }), ['each booking reconciliation must represent exactly one delegate place']);
});

test('event visibility separates delegates from unused allocation and true availability', () => {
  const result = mergeTicketCommercialCapacity(
    { available_count: 10, is_unlimited_tickets: false },
    3,
    { allocated: 8, named: 3, reserved: 1, released: 2, cancelled: 0, remaining: 6, unused: 2 },
  );
  assert.deepEqual(result, {
    commercial_allocated: 8,
    commercial_named: 3,
    commercial_reserved: 1,
    commercial_unused: 2,
    commercial_released: 2,
    commercial_cancelled: 0,
    true_available: 5,
    is_sold_out: false,
  });
});
