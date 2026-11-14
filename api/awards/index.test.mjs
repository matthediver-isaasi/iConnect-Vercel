import test from 'node:test';
import assert from 'node:assert/strict';
process.env.ROLE_ACCESS_OVERLAY_SKIP_PRIME = '1';
const { __setRoleAccessOverlayForTests } = await import('../_lib/roleVisibility.js');
__setRoleAccessOverlayForTests([]);
const { default: handler } = await import('./index.js');
const tenant = '11111111-1111-4111-8111-111111111111';
const actor = '22222222-2222-4222-8222-222222222222';
const award = '33333333-3333-4333-8333-333333333333';
function fixture({ exclusions = [], context = {}, rpcError = null } = {}) {
  const calls = [];
  const db = {
    from(table) {
      const q = {
        select(...args) { calls.push(['select', table, ...args]); return q; },
        eq(...args) { calls.push(['eq', table, ...args]); return q; },
        order() { return q; },
        maybeSingle() { return Promise.resolve({ data: { excluded_features: exclusions } }); },
        range(...args) { calls.push(['range', ...args]); return Promise.resolve({ data: [], count: 0 }); },
      };
      return q;
    },
    async rpc(name, args) { calls.push(['rpc', name, args]); return { data: { id: award }, error: rpcError }; },
  };
  const dependencies = { supabase: db, getTenantContext: async () => ({
    isAuthenticated: true, tenantId: tenant, roleId: actor, memberId: actor, ...context,
  }) };
  const run = async (changes = {}) => {
    const res = { statusCode: 200, setHeader() {}, status(code) { this.statusCode = code; return this; }, json(value) { this.body = value; return this; } };
    await handler({ method: 'GET', headers: {}, query: {}, ...changes }, res, dependencies);
    return res;
  };
  return { calls, run };
}
test('list is tenant-scoped, paginated and independent of client tenant input', async () => {
  const f = fixture(); const res = await f.run({ query: { tenant_id: 'forged', page: '2' } });
  assert.equal(res.statusCode, 200);
  assert.ok(f.calls.some(c => c[0] === 'eq' && c[1] === 'awards_competition' && c[2] === 'tenant_id' && c[3] === tenant));
  assert.ok(f.calls.some(c => c[0] === 'range' && c[1] === 50 && c[2] === 99));
});
test('authentication, stale tenants and granular exclusions fail closed', async () => {
  for (const [options, status] of [
    [{ context: { isAuthenticated: false } }, 401],
    [{ context: { tenantMismatch: true } }, 409],
    [{ context: { roleId: null } }, 403],
    [{ exclusions: ['awards'] }, 403],
    [{ exclusions: ['admin'] }, 403],
    [{ exclusions: ['awards.management'] }, 403],
  ]) {
    const f = fixture(options); assert.equal((await f.run()).statusCode, status);
    assert.equal(f.calls.some(c => c[0] === 'rpc'), false);
  }
});
const post = {
  method: 'POST', headers: { 'x-awards-request': '1', 'content-type': 'application/json' },
  body: { command: 'configure', id: award, version: 2, payload: { name: 'Research', tenant_id: 'forged' }, actor_id: 'forged' },
};
test('commands use server actor and tenant, with exact optimistic version', async () => {
  const f = fixture(); assert.equal((await f.run(post)).statusCode, 200);
  const args = f.calls.find(c => c[0] === 'rpc')[2];
  assert.equal(args.p_tenant, tenant); assert.equal(args.p_actor, actor); assert.equal(args.p_expected_version, 2);
});
test('cross-site writes and missing write capability do not reach persistence', async () => {
  for (const headers of [{}, { ...post.headers, 'sec-fetch-site': 'cross-site' }, { ...post.headers, 'content-type': 'text/plain' }]) {
    const f = fixture(); assert.equal((await f.run({ ...post, headers })).statusCode, 403);
    assert.equal(f.calls.some(c => c[0] === 'rpc'), false);
  }
  assert.equal((await fixture({ exclusions: ['awards.management.configure'] }).run(post)).statusCode, 403);
});
test('stale versions return conflict; missing installation is explicit', async () => {
  assert.equal((await fixture({ rpcError: { code: '40001', message: 'Reload' } }).run(post)).statusCode, 409);
  const missing = await fixture({ rpcError: { code: 'PGRST202' } }).run(post);
  assert.equal(missing.statusCode, 503);
  assert.match(missing.body.error, /not installed/);
});
