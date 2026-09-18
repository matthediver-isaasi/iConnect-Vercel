import test from 'node:test';
import assert from 'node:assert/strict';
import handler from './me.js';

const baseMember = {
  id: 'member-a',
  tenant_id: 'tenant-a',
  role_id: 'role-a',
  first_name: 'Ada',
  last_name: 'Lovelace',
};

function response() {
  return {
    statusCode: 200,
    headers: {},
    setHeader(key, value) { this.headers[key] = value; },
    status(code) { this.statusCode = code; return this; },
    json(value) { this.body = value; return this; },
    end() { return this; },
  };
}

function database(roleResult) {
  const calls = [];
  return {
    calls,
    from(table) {
      const call = { table, select: null, filters: [] };
      calls.push(call);
      return {
        select(columns) { call.select = columns; return this; },
        eq(column, value) { call.filters.push([column, value]); return this; },
        async maybeSingle() {
          if (table === 'role') return roleResult;
          if (table === 'tenant_user_member_link') return { data: null, error: null };
          if (table === 'tenant') {
            return { data: { slug: 'tenant-a', domain: 'a.example.test' }, error: null };
          }
          throw new Error(`Unexpected query ${table}`);
        },
      };
    },
  };
}

function dependencies(db, member = baseMember) {
  return {
    db,
    readMember: async () => member,
    readSession: async () => ({ data: { memberId: member.id, tenantId: member.tenant_id } }),
    resolveHostTenant: async () => ({ id: member.tenant_id }),
  };
}

const request = {
  method: 'GET',
  headers: { host: 'a.example.test' },
  query: { memberId: 'member-b', tenant: 'tenant-b' },
};

test('auth/me returns one full, tenant-bound session role read', async () => {
  const role = {
    id: 'role-a',
    tenant_id: 'tenant-a',
    name: 'Members',
    excluded_features: ['admin_can_edit_members'],
    default_landing_page: 'Dashboard',
    show_bookmarks: false,
    layout_theme: 'standard',
  };
  const db = database({ data: role, error: null });
  const res = response();

  await handler(request, res, dependencies(db));

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.sessionRole, {
    status: 'ready',
    member_id: 'member-a',
    tenant_id: 'tenant-a',
    role_id: 'role-a',
    role,
  });
  assert.equal(res.body.isAdmin, true);
  assert.equal(res.body.canEditMembers, true);
  assert.equal(res.body.canManageCommunications, true);
  const roleCalls = db.calls.filter(({ table }) => table === 'role');
  assert.equal(roleCalls.length, 1);
  assert.equal(roleCalls[0].select, '*');
  assert.deepEqual(roleCalls[0].filters, [['id', 'role-a']]);
  assert.match(res.headers['Cache-Control'], /private, no-store/);
});

test('auth/me reports missing and failed roles without granting capabilities or failing login', async () => {
  for (const [roleResult, expectedStatus] of [
    [{ data: null, error: null }, 'missing'],
    [{ data: null, error: { code: 'XX000', message: 'role read failed' } }, 'error'],
  ]) {
    const res = response();
    await handler(request, res, dependencies(database(roleResult)));

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.id, 'member-a');
    assert.deepEqual(res.body.sessionRole, {
      status: expectedStatus,
      member_id: 'member-a',
      tenant_id: 'tenant-a',
      role_id: 'role-a',
      role: null,
    });
    assert.equal(res.body.isAdmin, false);
    assert.equal(res.body.canEditMembers, false);
    assert.equal(res.body.canManageCommunications, false);
  }
});

test('auth/me rejects role rows with a foreign tenant or unexpected id', async () => {
  for (const role of [
    { id: 'role-a', tenant_id: 'tenant-b', excluded_features: [] },
    { id: 'role-b', tenant_id: 'tenant-a', excluded_features: [] },
  ]) {
    const res = response();
    await handler(request, res, dependencies(database({ data: role, error: null })));

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.sessionRole.status, 'error');
    assert.equal(res.body.sessionRole.role, null);
    assert.equal(res.body.isAdmin, false);
    assert.equal(res.body.canEditMembers, false);
    assert.equal(res.body.canManageCommunications, false);
  }
});

test('auth/me returns a typed missing snapshot when the member has no role', async () => {
  const member = { ...baseMember, role_id: null };
  const db = database({ data: null, error: null });
  const res = response();

  await handler(request, res, dependencies(db, member));

  assert.deepEqual(res.body.sessionRole, {
    status: 'missing',
    member_id: 'member-a',
    tenant_id: 'tenant-a',
    role_id: null,
    role: null,
  });
  assert.equal(db.calls.some(({ table }) => table === 'role'), false);
  assert.equal(res.body.isAdmin, false);
});