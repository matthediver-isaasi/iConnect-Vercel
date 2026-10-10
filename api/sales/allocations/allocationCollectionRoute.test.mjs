import test from 'node:test';
import assert from 'node:assert/strict';
import handler, { createSalesAllocationsHandler } from './index.js';

function response() {
  return { statusCode: 0, body: null, setHeader() {},
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; } };
}
test('collection entry point exists and requires authentication', async () => {
  assert.equal(typeof handler, 'function');
  const res = response();
  await createSalesAllocationsHandler({ db: {}, getTenantContext: async () => ({}) })({
    method: 'GET', url: '/api/sales/allocations', query: {},
  }, res);
  assert.equal(res.statusCode, 401);
});
test('empty granted-member collection returns 200 and cannot be redirected by query route parameters', async () => {
  for (const url of ['/api/sales/allocations', '/api/sales/allocations/?path=wrong&id=wrong&action=cancel']) {
    const scopes = [];
    const db = { from(table) {
      assert.equal(table, 'sales_commercial_allocation_manager');
      return { select() { return this; }, eq(k, v) { scopes.push([k, v]); return this; },
        is(k, v) { scopes.push([k, v]); return this; },
        then(resolve) { return Promise.resolve({ data: [], error: null }).then(resolve); } };
    } };
    const res = response();
    await createSalesAllocationsHandler({ db,
      getTenantContext: async () => ({ isAuthenticated: true, tenantId: 'tenant', memberId: 'member' }),
    })({ method: 'GET', url, query: { path: ['wrong'], id: 'wrong', action: 'cancel' } }, res);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body, { items: [] });
    assert.deepEqual(scopes, [['tenant_id', 'tenant'], ['member_id', 'member'], ['revoked_at', null]]);
  }
});
test('actual nested URL retains member lifecycle restrictions despite conflicting query parameters', async () => {
  const res = response();
  await createSalesAllocationsHandler({ db: {},
    getTenantContext: async () => ({ isAuthenticated: true, tenantId: 'tenant', memberId: 'member' }),
  })({ method: 'POST', url: '/api/sales/allocations/allocation/cancel',
    query: { path: ['allocation', 'invite'] }, body: {} }, res);
  assert.equal(res.statusCode, 403);
});
