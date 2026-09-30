import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemberCpdPointsHandler } from './member-cpd-points.js';

const MEMBER = '20000000-0000-0000-0000-000000000001';
const ENTRY = '30000000-0000-0000-0000-000000000001';
const KEY = '40000000-0000-0000-0000-000000000001';

function response() {
  return {
    code: 200,
    status(code) { this.code = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

function db({ member = { id: MEMBER }, entries = [], rpcResult = null, calls = [] } = {}) {
  return {
    from(table) {
      const query = {
        select() { return this; },
        eq() { return this; },
        maybeSingle() { return Promise.resolve({ data: table === 'member' ? member : null, error: null }); },
        order() { return this; },
        limit() { return Promise.resolve({ data: entries, error: null }); },
      };
      return query;
    },
    rpc(name, args) {
      calls.push({ name, args });
      return Promise.resolve({ data: rpcResult, error: null });
    },
  };
}

async function run({
  method = 'GET',
  query = { member_id: MEMBER },
  body = {},
  context = { isAuthenticated: true, tenantId: 'tenant', roleId: 'role', memberId: 'actor' },
  admin = false,
  feature = true,
  database = db(),
} = {}) {
  const req = { method, query, body };
  const res = response();
  const handler = createMemberCpdPointsHandler({
    db: database,
    getTenantContext: async () => context,
    hasAdminAccess: async () => admin,
    hasFeatureAccess: async (roleId, featureId) => {
      assert.equal(roleId, context.roleId);
      assert.equal(featureId, 'cpd.points-corrections');
      return feature;
    },
  });
  await handler(req, res);
  return res;
}

test('member admins require the dedicated capability and cannot bypass an explicit exclusion', async () => {
  assert.equal((await run({ context: null })).code, 401);
  assert.equal((await run({ feature: false })).code, 403);
  assert.equal((await run({ admin: true, feature: false })).code, 403);
  assert.equal((await run({ admin: false, feature: true })).code, 403);
  assert.equal((await run({ admin: true, feature: true })).code, 200);
});

test('tenant-user admin sessions are explicitly allowed without a member role', async () => {
  const context = {
    isAuthenticated: true,
    tenantId: 'tenant',
    tenantUserId: 'tenant-admin',
    roleId: null,
    memberId: null,
  };
  assert.equal((await run({ context, admin: false, feature: false })).code, 200);
});

test('member history is tenant-scoped and redacts internal evidence', async () => {
  const entry = {
    id: ENTRY, points_value: '2.500000', evidence_snapshot: { private: true },
    rule_snapshot: { private: true }, source_metadata: { private: true }, row_hash: 'secret',
  };
  const res = await run({ admin: true, database: db({ entries: [entry] }) });
  assert.equal(res.code, 200);
  assert.equal(res.body.entries[0].points_value, '2.500000');
  assert.equal(res.body.entries[0].evidence_snapshot, undefined);
  assert.equal(res.body.entries[0].row_hash, undefined);
  assert.equal((await run({ admin: true, database: db({ member: null }) })).code, 404);
});

test('corrections require reason and signed adjustment and call the guarded RPC', async () => {
  const calls = [];
  const database = db({
    calls,
    rpcResult: { id: KEY, points_value: '-1.25', entry_kind: 'manual_adjustment' },
  });
  assert.equal((await run({ method: 'POST', query: {}, body: {
    member_id: MEMBER, ledger_entry_id: ENTRY, action: 'adjust', points_value: '-1.25',
    correction_key: KEY, reason: '',
  }, admin: true, database })).code, 400);
  const res = await run({ method: 'POST', query: {}, body: {
    member_id: MEMBER, ledger_entry_id: ENTRY, action: 'adjust', points_value: '-1.25',
    correction_key: KEY, reason: 'Exceptional correction',
  }, admin: true, database });
  assert.equal(res.code, 201);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, 'correct_member_cpd_points');
  assert.equal(calls[0].args.p_tenant_id, 'tenant');
  assert.equal(calls[0].args.p_member_id, MEMBER);
  assert.equal(calls[0].args.p_reason, 'Exceptional correction');
});