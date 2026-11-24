import test from 'node:test';
import assert from 'node:assert/strict';
import { createOpportunityDetailHandler } from './[id].js';
import { salesPrincipalFixture, unifiedContext, salesResponse } from '../_lib/salesPrincipals.fixture.mjs';

const baseOpportunity = {
  id: 'opp-a', tenant_id: 'tenant-a', organization_id: 'org-a',
  stage_id: 'stage-a', owner_kind: 'member', owner_id: 'owner-a', version: 2,
};

function response() {
  return {
    statusCode: null, body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
    setHeader() {},
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
        or() { return chain; },
        update(value) { call.update = value; return chain; },
        insert(value) { call.insert = value; return chain; },
        maybeSingle() {
          if (table === 'organization') return Promise.resolve({ data: { id: 'primary-org' }, error: null });
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

test('archive and restore require management and pass server-owned tenant and actor', async () => {
  for (const action of ['archive', 'restore']) {
    const owner = fakeDb('owner-a');
    const res = response();
    await handlerFor('owner-a', owner)({ method: 'PATCH', query: { id: 'opp-a' },
      body: { action, expectedVersion: 2, tenantId: 'foreign' } }, res);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(owner.calls.find(c => c.rpc).args, {
      p_tenant: 'tenant-a', p_opportunity: 'opp-a', p_version: 2,
      p_action: action, p_actor_kind: 'member', p_actor_id: 'owner-a',
    });
    const collaborator = fakeDb('collab-a'), denied = response();
    await handlerFor('collab-a', collaborator)({ method: 'PATCH', query: { id: 'opp-a' },
      body: { action, expectedVersion: 2 } }, denied);
    assert.equal(denied.statusCode, 403);
    assert.ok(!collaborator.calls.some(c => c.rpc));
  }
});

test('permanent delete requires explicit confirmation and current version', async () => {
  for (const body of [{ expectedVersion: 2 }, { confirmDelete: true, expectedVersion: 1 }]) {
    const db = fakeDb('owner-a'), res = response();
    await handlerFor('owner-a', db)({ method: 'DELETE', query: { id: 'opp-a' }, body }, res);
    assert.ok([400, 409].includes(res.statusCode));
    assert.ok(!db.calls.some(c => c.rpc));
  }
  for (const code of ['PT409', '23503', 'PGRST202', 'P0002']) {
    const db = fakeDb('owner-a'), res = response();
    db.rpc = async () => ({ error: { code, message: 'Deletion blocked' } });
    await handlerFor('owner-a', db)({ method: 'DELETE', query: { id: 'opp-a' },
      body: { confirmDelete: true, expectedVersion: 2 } }, res);
    assert.equal(res.statusCode, code === 'PGRST202' ? 503 : code === 'P0002' ? 404 : 409);
  }
});

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

test('silent mode uses existing edit authority and strict versioned policy command', async () => {
  for (const principal of ['owner-a','collab-a','outsider']) {
    const db = fakeDb(principal);
    const res = response();
    await handlerFor(principal,db)({ method:'PATCH',query:{ id:'opp-a' },
      body:{ action:'silent-mode',expectedVersion:2,silentMode:true,automaticCommunications:['invoice'] } },res);
    if (principal === 'outsider') {
      assert.equal(res.statusCode,404);
      assert.equal(db.calls.some(c => c.rpc),false);
    } else {
      assert.equal(res.statusCode,200);
      const call = db.calls.find(c => c.rpc);
      assert.equal(call.rpc,'set_opportunity_silent_mode');
      assert.equal(call.args.p_tenant,'tenant-a');
      assert.equal(call.args.p_opportunity,'opp-a');
      assert.equal(call.args.p_actor_id,principal);
      assert.equal(call.args.p_version,2);
      assert.deepEqual(call.args.p_allowed,['invoice']);
    }
  }
});

test('silent mode rejects invalid inputs and reports concurrent saves without a fallback update', async () => {
  for (const patch of [
    {silentMode:'true'}, {automaticCommunications:['unknown']}, {automaticCommunications:['invoice','invoice']},
    {expectedVersion:1},
  ]) {
    const db = fakeDb('owner-a'); const res = response();
    await handlerFor('owner-a',db)({method:'PATCH',query:{id:'opp-a'},
      body:{action:'silent-mode',expectedVersion:2,silentMode:true,automaticCommunications:[],...patch}},res);
    assert.ok([400,409].includes(res.statusCode));
    assert.equal(db.calls.some(c => c.rpc || c.update),false);
  }
  const db = fakeDb('owner-a'); const res = response();
  db.rpc = async () => ({error:{code:'PT409'}});
  await handlerFor('owner-a',db)({method:'PATCH',query:{id:'opp-a'},
    body:{action:'silent-mode',expectedVersion:2,silentMode:true,automaticCommunications:[]}},res);
  assert.equal(res.statusCode,409);
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

test('explicit owner updates and task assignees use the same scoped unified principal checks', async () => {
  for (const id of ['identity', 'legacy', 'foreign', 'inactive', 'ordinary', 'absent', 'missing-identity']) {
    for (const action of ['owner', 'assignee']) {
      const db = salesPrincipalFixture(), res = salesResponse();
      db.rows.opportunity.push({ id: 'opp', tenant_id: 'tenant-a', organization_id: 'org',
        stage_id: 'stage', owner_kind: 'tenant_user', owner_id: 'legacy', version: 1 });
      const handler = createOpportunityDetailHandler({ db, getTenantContext: async () => unifiedContext,
        requireCapability: async () => {}, hasAdminAccess: async () => true });
      const principal = { kind: 'tenant_user', id };
      await handler(action === 'owner'
        ? { method: 'PATCH', query: { id: 'opp' }, body: { expectedVersion: 1, owner: principal } }
        : { method: 'POST', query: { id: 'opp', resource: 'tasks' }, body: { title: 'Follow up', assignee: principal } }, res);
      const valid = ['identity', 'legacy'].includes(id);
      assert.equal(res.statusCode, valid ? (action === 'owner' ? 200 : 201) : 404, JSON.stringify(res.body));
      if (valid) assert.equal(res.body[action === 'owner' ? 'owner_id' : 'assignee_id'], id);
      else assert.equal(db.calls.some(call => call.table === 'opportunity_activity'), false);
    }
  }
});