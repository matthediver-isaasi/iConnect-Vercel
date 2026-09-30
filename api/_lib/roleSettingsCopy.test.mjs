import test from 'node:test';
import assert from 'node:assert/strict';
process.env.ROLE_ACCESS_OVERLAY_SKIP_PRIME = '1';
const { __setRoleAccessOverlayForTests } = await import('./roleVisibility.js');
__setRoleAccessOverlayForTests([]);
const { copyRoleSettings } = await import('./roleSettingsCopy.js');

const sourceRoleId = '00000000-0000-0000-0000-000000000001';
const targetRoleId = '00000000-0000-0000-0000-000000000002';
const context = { isAuthenticated: true, tenantId: 'tenant', tenantUserId: 'admin' };
function db(actor = {}, failure = null) {
  const calls = [];
  return {
    calls,
    from() { return this; }, select() { return this; },
    eq(...args) { calls.push(args); return this; },
    async maybeSingle() { return { data: actor }; },
    async rpc(name, params) { calls.push({ name, params }); return { data: { id: targetRoleId }, error: failure }; },
  };
}
const run = (database, ctx = context, source = sourceRoleId, target = targetRoleId) =>
  copyRoleSettings({ db: database, context: ctx, sourceRoleId: source, targetRoleId: target });

test('rejects anonymous, mismatch, missing tenant and invalid/same IDs without writes', async () => {
  for (const [ctx, source, target, status] of [
    [null, sourceRoleId, targetRoleId, 401],
    [{ ...context, tenantMismatch: true }, sourceRoleId, targetRoleId, 401],
    [{ ...context, tenantId: null }, sourceRoleId, targetRoleId, 400],
    [context, sourceRoleId, sourceRoleId, 400],
    [context, 'invalid', targetRoleId, 400],
    [context, [sourceRoleId], targetRoleId, 400],
  ]) {
    const database = db();
    assert.equal((await run(database, ctx, source, target)).status, status);
    assert.equal(database.calls.length, 0);
  }
});
test('uses a single transaction RPC with server-derived authority, not caller settings', async () => {
  const database = db();
  assert.equal((await run(database)).body.role.id, targetRoleId);
  assert.deepEqual(database.calls, [{
    name: 'copy_role_access_settings',
    params: { p_tenant_id: 'tenant', p_source_role_id: sourceRoleId, p_target_role_id: targetRoleId, p_can_manage_tenant_admin: true },
  }]);
});
test('member authorization is role-management specific and tenant scoped', async () => {
  const ctx = { ...context, tenantUserId: null, roleId: sourceRoleId };
  for (const actor of [null, { excluded_features: ['admin.role-management'] }]) {
    const database = db(actor);
    assert.equal((await run(database, ctx)).status, 403);
    assert.deepEqual(database.calls[1], ['tenant_id', 'tenant']);
    assert.ok(database.calls.every(call => !call.name));
  }
  const database = db({ excluded_features: [], is_tenant_admin: false });
  assert.equal((await run(database, ctx)).status, 200);
  assert.equal(database.calls.at(-1).params.p_can_manage_tenant_admin, false);
});
test('RPC failures never report partial success or disclose database internals', async () => {
  for (const [code, status] of [['P0002', 404], ['42501', 403], ['22023', 400], ['XX000', 500]]) {
    const result = await run(db({}, { code, message: 'private SQL' }));
    assert.equal(result.status, status);
    assert.equal(result.body.role, undefined);
    assert.ok(!result.body.error.includes('private SQL'));
  }
});

test('individual member Role Management exclusion denies an otherwise authorized role without an RPC', async () => {
  const database = db({ excluded_features: [], is_tenant_admin: true });
  const result = await run(database, {
    ...context,
    tenantUserId: null,
    roleId: sourceRoleId,
    memberExcludedFeatures: ['admin.role-management'],
  });
  assert.equal(result.status, 403);
  assert.equal(result.body.error, 'Role Management access required');
  assert.ok(database.calls.every(call => !call.name), 'no mutation RPC may run');
});