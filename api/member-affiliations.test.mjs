import test from 'node:test';
import assert from 'node:assert/strict';
import handler from './member-affiliations.js';
import settings from './member-affiliation-settings.js';
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
function fixture(enabled = true) {
  const calls = [];
  const state = { enabled, fail: false };
  const db = { from() {
    const q = { select() { return q; }, eq() { return q; },
      maybeSingle: async () => state.fail ? { error: new Error('Unavailable') } : { data: { version: 1, config: { enabled: state.enabled } } } };
    return q;
  }, async rpc(name, args) { calls.push({ name, args }); return { data: { committed: true, replayed: false } }; } };
  const deps = { db, getTenantContext: async () => ({ isAuthenticated: true, tenantId: id(1) }),
    getSession: async () => ({ data: { memberId: id(2) } }),
    getSessionMember: async () => ({ id: id(2), tenant_id: id(1) }),
    validatePolicy: async () => ({ complete: true }) };
  const res = { code: 200, setHeader() {}, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
  return { deps, res, calls, state };
}
test('member endpoint derives identity and passes only explicit selections to atomic RPC', async () => {
  const f = fixture();
  await handler({ method: 'PATCH', body: { token: id(3), departments: [] } }, f.res, f.deps);
  assert.equal(f.res.body.committed, true);
  assert.deepEqual(f.calls[0], { name: 'profile_affiliation_apply', args: {
    p_tenant: id(1), p_member: id(2), p_token: id(3), p_request: { departments: [] },
  } });
});
test('disabled, unavailable, forged owner and wrong tenant never write', async () => {
  for (const kind of ['disabled', 'unavailable', 'spoof', 'tenant', 'session', 'switched']) {
    const f = fixture(kind !== 'disabled');
    if (kind === 'unavailable') f.state.fail = true;
    if (kind === 'tenant') f.deps.getSessionMember = async () => ({ id: id(2), tenant_id: id(9) });
    if (kind === 'session') f.deps.getSession = async () => ({ data: { memberId: id(9) } });
    if (kind === 'switched') f.deps.getTenantContext = async () => ({ tenantId: id(1), tenantMismatch: true });
    await handler({ method: 'PATCH', body: { token: id(3), ...(kind === 'spoof' ? { memberId: id(9) } : {}) } }, f.res, f.deps);
    assert.ok(f.res.code >= 400, kind);
    assert.equal(f.calls.length, 0, kind);
  }
  const f = fixture(false);
  await handler({ method: 'GET' }, f.res, f.deps);
  assert.deepEqual(f.res.body, { active: false });
});
test('revoking the setting between load and save is denied', async () => {
  const f = fixture();
  f.state.enabled = false;
  await handler({ method: 'PATCH', body: { token: id(3), primary: null } }, f.res, f.deps);
  assert.equal(f.res.code, 403); assert.equal(f.calls.length, 0);
});
test('members cannot read or configure their permissions', async () => {
  for (const method of ['GET', 'PUT']) {
    const f = fixture();
    await settings({ method, body: { version: 0, config: { enabled: true } } }, f.res, {
      ...f.deps, hasAdminAccess: async () => false,
    });
    assert.equal(f.res.code, 403); assert.equal(f.calls.length, 0);
  }
});
