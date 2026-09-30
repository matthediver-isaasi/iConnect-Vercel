import test from 'node:test';
import assert from 'node:assert/strict';
import { createOpportunitySettingsHandler } from './index.js';

test('unknown opportunity settings resource returns 400 before database access', async () => {
  let databaseUsed = false;
  const handler = createOpportunitySettingsHandler({
    db: { from() { databaseUsed = true; throw new Error('must not query'); } },
    getTenantContext: async () => ({
      isAuthenticated: true, tenantId: 'tenant-a', tenantUserId: 'admin-a',
    }),
  });
  const res = {
    statusCode: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
  await handler({ method: 'GET', query: { resource: 'not-a-resource' } }, res);
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error, 'Unknown settings resource');
  assert.equal(databaseUsed, false);
});

test('stage creation uses the serialized server RPC and ignores client position', async () => {
  const calls = [];
  const db = {
    rpc(name, args) {
      calls.push({ rpc: name, args });
      return Promise.resolve({ data: [{ id: 'stage-new', position: 8 }], error: null });
    },
    from(table) {
      const call = { table, filters: [] }; calls.push(call);
      const chain = {
        select() { return chain; },
        eq(key, value) { call.filters.push([key, value]); return chain; },
        order() { return chain; },
        limit() { return chain; },
        maybeSingle() { return Promise.resolve({ data: { position: 7 }, error: null }); },
        insert(value) { call.inserted = value; return chain; },
        single() { return Promise.resolve({ data: { id: 'stage-new', ...call.inserted }, error: null }); },
      };
      return chain;
    },
  };
  const handler = createOpportunitySettingsHandler({
    db,
    getTenantContext: async () => ({ isAuthenticated: true, tenantId: 'tenant-a', tenantUserId: 'admin-a' }),
    hasAdminAccess: async () => true,
  });
  const res = { statusCode: null, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
  await handler({
    method: 'POST', query: { resource: 'stages' },
    body: { name: 'New', position: 1, probability: 50 },
  }, res);
  assert.equal(res.statusCode, 201);
  assert.deepEqual(calls[0], {
    rpc: 'create_opportunity_stage',
    args: {
      p_tenant_id: 'tenant-a', p_name: 'New', p_color: '#64748b',
      p_probability: 50, p_is_won: false, p_is_lost: false,
    },
  });
  assert.equal(res.body.position, 8);
});

test('settings GET filters soft-deleted rows and returns the stage order version', async () => {
  const calls = [];
  const db = {
    from(table) {
      const call = { table, filters: [] }; calls.push(call);
      const chain = {
        select() { return chain; },
        eq(key, value) { call.filters.push([key, value]); return chain; },
        order() { return chain; },
        maybeSingle() { return Promise.resolve({ data: { order_version: 4 }, error: null }); },
        then(resolve) {
          return Promise.resolve({
            data: table === 'opportunity_stage' ? [{ id: 'active-stage', is_active: true }] : [],
            error: null,
          }).then(resolve);
        },
      };
      return chain;
    },
  };
  const handler = createOpportunitySettingsHandler({
    db,
    getTenantContext: async () => ({ isAuthenticated: true, tenantId: 'tenant-a', tenantUserId: 'admin-a' }),
  });
  const res = { status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
  await handler({ method: 'GET', query: { resource: 'stages' } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.orderVersion, 4);
  assert.deepEqual(calls[0].filters, [['tenant_id', 'tenant-a'], ['is_active', true]]);
});

test('stage deactivation reports a conflict before an in-use stage is changed', async () => {
  const db = { from() {
    const chain = {
      select() { return chain; }, eq() { return chain; },
      then(resolve) { return Promise.resolve({ count: 1, error: null }).then(resolve); },
    };
    return chain;
  } };
  const handler = createOpportunitySettingsHandler({
    db,
    getTenantContext: async () => ({ isAuthenticated: true, tenantId: 'tenant-a', tenantUserId: 'admin-a' }),
    hasAdminAccess: async () => true,
  });
  const res = { status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
  await handler({ method: 'DELETE', query: { resource: 'stages', id: 'used-stage' } }, res);
  assert.equal(res.statusCode, 409);
  assert.match(res.body.error, /Cannot deactivate/i);
});

function classificationPatchHandler(opportunityCount) {
  const updates = [];
  const db = { from() {
    const chain = {
      select() { return chain; }, eq() { return chain; },
      update(value) { chain.updated = value; updates.push(value); return chain; },
      maybeSingle() {
        return Promise.resolve(chain.updated
          ? { data: { id: 'stage-a', ...chain.updated }, error: null }
          : { data: { id: 'stage-a', is_won: false, is_lost: false,
            opportunity_count: opportunityCount }, error: null });
      },
    };
    return chain;
  } };
  return {
    updates,
    handler: createOpportunitySettingsHandler({
      db,
      getTenantContext: async () => ({ isAuthenticated: true, tenantId: 'tenant-a', tenantUserId: 'admin-a' }),
      hasAdminAccess: async () => true,
    }),
  };
}

test('occupied stage won/lost reclassification returns 409', async () => {
  const { handler, updates } = classificationPatchHandler(2);
  const res = { status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
  await handler({
    method: 'PATCH', query: { resource: 'stages', id: 'stage-a' }, body: { is_won: true },
  }, res);
  assert.equal(res.statusCode, 409);
  assert.match(res.body.error, /classification/i);
  assert.equal(updates.length, 0);
});

test('unoccupied stage won/lost reclassification remains allowed', async () => {
  const { handler, updates } = classificationPatchHandler(0);
  const res = { status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
  await handler({
    method: 'PATCH', query: { resource: 'stages', id: 'stage-a' }, body: { is_won: true },
  }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(updates.length, 1);
  assert.equal(updates[0].is_won, true);
});