import test from 'node:test';
import assert from 'node:assert/strict';
import { createBoardMembersHandler } from './members.js';

function fixture({ role = 'owner', boardTenant = 'tenant', error, data = { id: 'membership' }, authenticated = true } = {}) {
  const calls = [];
  const db = {
    from(table) {
      const filters = {};
      const q = {
        select() { return q; }, eq(k, v) { filters[k] = v; return q; },
        async maybeSingle() { return { data: boardTenant === filters.tenant_id ? { id: 'board' } : null }; },
        async single() { return { data: role ? { role } : null }; },
      };
      calls.push({ table, filters });
      return q;
    },
    async rpc(name, args) { calls.push({ name, args }); return { data, error }; },
  };
  const handler = createBoardMembersHandler({ db, sessionFor: async () => authenticated
    ? { data: { tenantId: 'tenant', identityId: 'self' } } : null });
  const res = { statusCode: 200, setHeader() {}, status(n) { this.statusCode = n; return this; },
    json(body) { this.body = body; return this; } };
  return { calls, res, run: (method = 'PATCH', body = {}) =>
    handler({ method, headers: {}, query: { boardId: 'board' }, body }, res) };
}

test('all membership writes pass trusted session identity through the locked database authority', async () => {
  for (const [method, action] of [['POST', 'add'], ['PATCH', 'role'], ['DELETE', 'remove']]) {
    const f = fixture();
    await f.run(method, { identity_id: 'target', role: 'member', p_actor: 'spoof', tenantId: 'foreign' });
    assert.equal(f.res.statusCode, method === 'POST' ? 201 : 200);
    assert.deepEqual(f.calls.find(c => c.name), { name: 'change_project_board_member', args: {
      p_tenant: 'tenant', p_board: 'board', p_actor: 'self', p_target: 'target',
      p_action: action, p_role: method === 'DELETE' ? null : 'member',
    } });
  }
});

test('admins cannot grant ownership through either invitations or role changes', async () => {
  for (const method of ['POST', 'PATCH']) {
    const f = fixture({ role: 'admin' });
    await f.run(method, { identity_id: 'target', role: 'owner' });
    assert.equal(f.res.statusCode, 403);
    assert(!f.calls.some(c => c.name));
  }
});

test('authentication, tenant visibility, membership and valid roles remain mandatory', async () => {
  for (const [options, body, expected] of [
    [{ authenticated: false }, {}, 401], [{ boardTenant: 'foreign' }, {}, 404],
    [{ role: null }, {}, 403], [{ role: 'viewer' }, { identity_id: 'target', role: 'member' }, 403],
    [{}, {}, 400], [{}, { identity_id: 'target', role: 'invalid' }, 400],
  ]) {
    const f = fixture(options); await f.run('PATCH', body);
    assert.equal(f.res.statusCode, expected);
    assert(!f.calls.some(c => c.name));
  }
});

test('last-owner conflicts and stale permissions surface clearly without fallback writes', async () => {
  for (const [code, status] of [['PT409', 409], ['42501', 403], ['P0002', 404],
    ['23505', 400], ['PGRST202', 503], ['XX000', 500]]) {
    const f = fixture({ error: { code, message: 'Assign another owner first.' } });
    await f.run('PATCH', { identity_id: 'self', role: 'admin' });
    assert.equal(f.res.statusCode, status);
    if (code === 'PT409') assert.match(f.res.body.error, /another owner/);
    assert.equal(f.calls.filter(c => c.name).length, 1);
  }
  const f = fixture({ data: null });
  await f.run('DELETE', { identity_id: 'target' });
  assert.equal(f.res.statusCode, 500);
});
