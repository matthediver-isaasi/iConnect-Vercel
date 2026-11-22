import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemberLifecycleHandler } from './member-lifecycle.js';
import { DEFAULT_LIFECYCLE_POLICY } from '../../shared/memberLifecyclePolicy.mjs';

function setup(options = {}) {
  const writes = [], reads = [];
  const db = { from(table) {
    reads.push(table);
    const chain = {
      select() { return chain; }, eq() { return chain; },
      async maybeSingle() { return { data: { policy: DEFAULT_LIFECYCLE_POLICY, revision: 1, enabled: false } }; },
    };
    return chain;
  }, async rpc(name, args) { writes.push({ name, args }); return { data: {} }; } };
  const handler = createMemberLifecycleHandler({
    db, getContext: async () => ({ isAuthenticated: true, tenantId: 'tenant', memberId: 'member', roleId: 'role' }),
    isAdmin: async () => true, featureAccess: async () => true,
    readRows: async () => [{ id: 'role', tenant_id: 'tenant', name: 'Existing tenant role' }],
    ...options,
  });
  return { writes, reads, async request(method = 'GET', body = {}, query = {}) {
    const res = { code: 200, setHeader() {}, status(code) { this.code = code; return this; }, json(value) { this.body = value; return this; } };
    await handler({ method, body, query }, res);
    return res;
  } };
}
test('settings expose dynamic roles and explicit non-executable preparation state', async () => {
  const { request } = setup();
  const response = await request();
  assert.equal(response.code, 200);
  assert.equal(response.body.enabled, false);
  assert.equal(response.body.executionReady, false);
  assert.ok(response.body.readinessIssues.length);
  assert.equal(response.body.roles[0].name, 'Existing tenant role');
});
test('authentication, tenant mismatch, admin and capability checks precede data reads', async () => {
  for (const [options, status] of [
    [{ getContext: async () => null }, 401],
    [{ getContext: async () => ({ isAuthenticated: true, tenantMismatch: true }) }, 409],
    [{ isAdmin: async () => false }, 403],
    [{ featureAccess: async () => false }, 403],
  ]) {
    const harness = setup(options);
    assert.equal((await harness.request()).code, status);
    assert.equal(harness.reads.length, 0);
    assert.equal(harness.writes.length, 0);
  }
});
test('member-specific exclusions are passed to existing permission checks', async () => {
  const exclusions = ['crm.member-lifecycle.configure'], checked = [];
  const harness = setup({
    getContext: async () => ({ isAuthenticated: true, tenantId: 'tenant', memberId: 'member',
      roleId: 'role', memberExcludedFeatures: exclusions }),
    featureAccess: async (_role, resource, memberExclusions) => {
      checked.push(memberExclusions);
      return !memberExclusions.includes(resource);
    },
  });
  assert.equal((await harness.request('PUT', { policy: DEFAULT_LIFECYCLE_POLICY, expectedRevision: 1 })).code, 403);
  assert.ok(checked.every(value => value === exclusions));
  assert.equal(harness.writes.length, 0);
});
test('saving draft uses server tenant/actor and optimistic revision, never enables automation', async () => {
  const harness = setup();
  assert.equal((await harness.request('PUT', {
    policy: DEFAULT_LIFECYCLE_POLICY, expectedRevision: 1, tenantId: 'attacker', actor: 'attacker',
  })).code, 200);
  assert.equal(harness.writes[0].args.p_tenant_id, 'tenant');
  assert.equal(harness.writes[0].args.p_actor, 'member:member');
  assert.equal(harness.writes[0].args.p_expected_revision, 1);
  assert.equal(harness.writes[0].args.p_policy.enabled, undefined);
});
test('invalid policy and revision are rejected without writes', async () => {
  for (const body of [{ policy: { enabled: true }, expectedRevision: 1 },
    { policy: DEFAULT_LIFECYCLE_POLICY, expectedRevision: -1 }]) {
    const harness = setup();
    assert.equal((await harness.request('PUT', body)).code, 400);
    assert.equal(harness.writes.length, 0);
  }
});
test('all execution, approval and destructive actions fail explicitly without writes', async () => {
  for (const action of ['approve', 'pause', 'retain', 'release_hold', 'extend', 'exempt', 'clear_exemption',
    'archive', 'restore', 'minimise_preview', 'minimise', 'delete_preview', 'delete']) {
    const harness = setup();
    const response = await harness.request('POST', { action });
    assert.equal(response.code, 409, action);
    assert.match(response.body.error, /not ready/);
    assert.equal(harness.writes.length, 0);
  }
});
test('missing migration and review availability are explicit, not empty-success responses', async () => {
  const harness = setup({ db: { from() { throw new Error('private database detail'); } } });
  const response = await harness.request();
  assert.equal(response.code, 503);
  assert.doesNotMatch(response.body.error, /private database detail/);
  assert.equal((await setup().request('GET', {}, { section: 'review' })).code, 409);
});
