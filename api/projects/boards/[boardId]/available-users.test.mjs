import test from 'node:test';
import assert from 'node:assert/strict';
import { createAvailableUsersHandler } from './available-users.js';

const roleId = '10000000-0000-0000-0000-000000000001';
function fixture({ permission = 'owner', failure, authenticated = true } = {}) {
  const calls = [];
  const rows = Array.from({ length: 26 }, (_, i) => ({
    tenant_id: i === 25 ? 'foreign' : 'tenant',
    role_id: i >= 21 ? roleId : 'other',
    identity_id: `person-${i}`,
    email: `person${i}@example.test`,
    first_name: 'Person', last_name: String(i),
    tenant_identity: { id: `person-${i}` },
  }));
  const db = { from(table) {
    const call = { table, filters: [] }; calls.push(call);
    const q = {
      select() { return q; }, order() { return q; },
      eq(k, v) { call.filters.push(row => row[k] === v); return q; },
      not(k, op, v) { call.filters.push(row => op === 'is' ? row[k] !== v : !v.slice(1, -1).split(',').includes(row[k])); return q; },
      or(value) { call.search = value; return q; },
      limit(value) { call.limit = value; return q; },
      maybeSingle() { call.single = true; return q; },
      then(resolve) {
        let data;
        if (table === 'project_board_member') data = call.single ? (permission ? { role: permission } : null) : [{ identity_id: 'person-21' }];
        if (table === 'role') data = [{ id: roleId, tenant_id: 'tenant' }].find(row => call.filters.every(f => f(row))) || null;
        if (table === 'member') {
          data = rows.filter(row => call.filters.every(f => f(row)));
          if (call.search) {
            const term = JSON.parse(call.search.split('email.ilike.')[1].split(',first_name')[0]).slice(1, -1);
            data = data.filter(row => [row.email, row.first_name, row.last_name].some(v => v.toLowerCase().includes(term)));
          }
          data = data.slice(0, call.limit);
        }
        return Promise.resolve({ data, error: failure === table ? { message: 'database unavailable' } : null }).then(resolve);
      },
    }; return q;
  } };
  const handler = createAvailableUsersHandler({ db, sessionFor: async () => authenticated ? { data: { identityId: 'self', tenantId: 'tenant' } } : null });
  const res = { statusCode: 200, setHeader() {}, status(n) { this.statusCode = n; return this; }, json(body) { this.body = body; return this; } };
  return { calls, res, run: query => handler({ method: 'GET', headers: {}, query: { boardId: 'board', ...query } }, res) };
}

test('all roles, role-only, combined and clearing filter apply before the limit', async () => {
  for (const [query, ids] of [
    [{}, Array.from({ length: 20 }, (_, i) => `person-${i}`)],
    [{ role_id: roleId }, ['person-22', 'person-23', 'person-24']],
    [{ role_id: roleId, search: 'person23@' }, ['person-23']],
    [{ search: 'person23@' }, ['person-23']],
    [{ role_id: roleId, search: 'missing' }, []],
  ]) {
    const f = fixture(); await f.run(query);
    assert.equal(f.res.statusCode, 200);
    assert.deepEqual(f.res.body.users.map(u => u.id), ids);
  }
});

test('only owner/admin may search and invalid or foreign roles never broaden results', async () => {
  for (const [options, query, status] of [
    [{ permission: 'admin' }, { role_id: roleId }, 200],
    [{ permission: 'viewer' }, {}, 403],
    [{ permission: 'member' }, {}, 403],
    [{ permission: null }, {}, 403],
    [{ authenticated: false }, {}, 401],
    [{}, { role_id: 'bad' }, 400],
    [{}, { role_id: '' }, 400],
    [{}, { role_id: [roleId] }, 400],
    [{}, { role_id: '20000000-0000-0000-0000-000000000002' }, 400],
  ]) {
    const f = fixture(options); await f.run(query);
    assert.equal(f.res.statusCode, status);
    if (status !== 200) assert.ok(!f.calls.some(c => c.table === 'member'));
  }
});

test('database failures remain errors including exclusion and role lookups', async () => {
  for (const failure of ['project_board_member', 'role', 'member']) {
    const f = fixture({ failure }); await f.run({ role_id: roleId });
    assert.equal(f.res.statusCode, 500);
    assert.ok(!f.res.body.users);
  }
});
