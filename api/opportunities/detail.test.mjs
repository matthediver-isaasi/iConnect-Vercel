import test from 'node:test';
import assert from 'node:assert/strict';
import { createOpportunityDetailHandler } from './[id].js';

const baseOpportunity = {
  id: 'opp-a', tenant_id: 'tenant-a', organization_id: 'org-a',
  stage_id: 'stage-a', owner_kind: 'member', owner_id: 'owner-a', version: 2,
};

function response() {
  return {
    statusCode: null, body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

function fakeDb(principalId) {
  const calls = [];
  const collaborators = principalId === 'collab-a'
    ? [{ opportunity_id: 'opp-a', principal_kind: 'member', principal_id: 'collab-a' }] : [];
  return {
    calls,
    rpc(name, args) {
      calls.push({ rpc: name, args });
      return Promise.resolve({ data: [{ ...baseOpportunity, stage_id: args.p_stage_id, version: 3 }], error: null });
    },
    from(table) {
      const call = { table }; calls.push(call);
      const chain = {
        select() { return chain; }, eq() { return chain; },
        update(value) { call.update = value; return chain; },
        insert(value) { call.insert = value; return chain; },
        maybeSingle() {
          if (table === 'opportunity') {
            return Promise.resolve({ data: { ...baseOpportunity, ...(call.update || {}) }, error: null });
          }
          if (table === 'opportunity_stage') {
            return Promise.resolve({ data: {
              id: 'stage-b', tenant_id: 'tenant-a', name: 'Next',
              is_active: true, is_lost: false, is_won: false,
            }, error: null });
          }
          if (table === 'member') return Promise.resolve({ data: { id: 'new-collab' }, error: null });
          return Promise.resolve({ data: null, error: null });
        },
        single() { return Promise.resolve({ data: call.insert, error: null }); },
        then(resolve) {
          const data = table === 'opportunity_collaborator' && !call.insert ? collaborators : call.insert;
          return Promise.resolve({ data, error: null }).then(resolve);
        },
      };
      return chain;
    },
  };
}

function handlerFor(principalId, db, isAdmin = false) {
  return createOpportunityDetailHandler({
    db,
    getTenantContext: async () => ({
      isAuthenticated: true, tenantId: 'tenant-a', memberId: principalId,
      roleId: 'role-a', memberExcludedFeatures: [],
    }),
    hasFeatureAccess: async () => true,
    hasAdminAccess: async () => isAdmin,
  });
}

test('collaborator can patch ordinary fields with optimistic versioning', async () => {
  const db = fakeDb('collab-a');
  const res = response();
  await handlerFor('collab-a', db)({
    method: 'PATCH', query: { id: 'opp-a' }, body: { expectedVersion: 2, name: 'Edited' },
  }, res);
  assert.equal(res.statusCode, 200);
  const update = db.calls.find((call) => call.table === 'opportunity' && call.update);
  assert.equal(update.update.name, 'Edited');
  assert.equal(update.update.version, 3);
});

test('collaborator can perform a versioned stage move', async () => {
  const db = fakeDb('collab-a');
  const res = response();
  await handlerFor('collab-a', db)({
    method: 'PATCH', query: { id: 'opp-a' },
    body: { action: 'move', expectedVersion: 2, stageId: 'stage-b' },
  }, res);
  assert.equal(res.statusCode, 200);
  assert.ok(db.calls.some((call) => call.rpc === 'move_opportunity'
    && call.args.p_expected_version === 2));
});

test('collaborator cannot change owner or mutate collaborators', async () => {
  for (const request of [
    { method: 'PATCH', query: { id: 'opp-a' },
      body: { expectedVersion: 2, owner: { kind: 'member', id: 'new-owner' } } },
    { method: 'POST', query: { id: 'opp-a', resource: 'collaborators' },
      body: { principal: { kind: 'member', id: 'new-collab' } } },
  ]) {
    const db = fakeDb('collab-a');
    const res = response();
    await handlerFor('collab-a', db)(request, res);
    assert.equal(res.statusCode, 403);
  }
});

test('owner can add collaborators', async () => {
  const db = fakeDb('owner-a');
  const res = response();
  await handlerFor('owner-a', db)({
    method: 'POST', query: { id: 'opp-a', resource: 'collaborators' },
    body: { principal: { kind: 'member', id: 'new-collab' } },
  }, res);
  assert.equal(res.statusCode, 201);
  assert.ok(db.calls.some((call) => call.table === 'opportunity_collaborator' && call.insert));
});

test('admin can change opportunity ownership', async () => {
  const db = fakeDb('admin-a');
  const res = response();
  await handlerFor('admin-a', db, true)({
    method: 'PATCH', query: { id: 'opp-a' },
    body: { expectedVersion: 2, owner: { kind: 'member', id: 'new-collab' } },
  }, res);
  assert.equal(res.statusCode, 200);
  const update = db.calls.find((call) => call.table === 'opportunity' && call.update);
  assert.equal(update.update.owner_id, 'new-collab');
});