import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemberCpdPointsHandler } from './cpd-points.js';

function response() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

test('allows a member to read only their own tenant-scoped CPD history', async () => {
  let request;
  const handler = createMemberCpdPointsHandler({
    db: {},
    getSessionMember: async () => ({ id: 'member-1', tenant_id: 'tenant-1' }),
    getTenantContext: async () => { throw new Error('admin fallback should not run'); },
    loadMemberCpdPointsHistory: async (input) => {
      request = input;
      return { balance: 4, items: [], total: 0, page: 2, pageSize: 10 };
    },
  });
  const res = response();
  await handler({ method: 'GET', query: { memberId: 'member-1', page: '2', pageSize: '10' } }, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(request, { tenantId: 'tenant-1', memberId: 'member-1', page: 2, pageSize: 10 });
});

test('denies another member and does not query the ledger', async () => {
  let queried = false;
  const handler = createMemberCpdPointsHandler({
    db: {},
    getSessionMember: async () => ({ id: 'member-2', tenant_id: 'tenant-1' }),
    getTenantContext: async () => ({ tenantId: 'tenant-1' }),
    hasAdminAccess: async () => false,
    loadMemberCpdPointsHistory: async () => { queried = true; },
  });
  const res = response();
  await handler({ method: 'GET', query: { memberId: 'member-1' } }, res);
  assert.equal(res.statusCode, 403);
  assert.equal(queried, false);
});

test('allows an authorized tenant admin and preserves the context tenant', async () => {
  let request;
  const handler = createMemberCpdPointsHandler({
    db: {},
    getSessionMember: async () => null,
    getTenantContext: async () => ({ tenantId: 'tenant-admin' }),
    hasAdminAccess: async () => true,
    loadMemberCpdPointsHistory: async (input) => {
      request = input;
      return { balance: 0, items: [], total: 0, page: 1, pageSize: 20 };
    },
  });
  const res = response();
  await handler({ method: 'GET', query: { memberId: 'member-1' } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(request.tenantId, 'tenant-admin');
});