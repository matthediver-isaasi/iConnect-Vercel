import test from 'node:test';
import assert from 'node:assert/strict';

process.env.ROLE_ACCESS_OVERLAY_SKIP_PRIME = '1';
const { __setRoleAccessOverlayForTests } = await import('../_lib/roleVisibility.js');
__setRoleAccessOverlayForTests([]);
const { default: handler } = await import('./me.js');

const member = {
  id: 'member-a', tenant_id: 'tenant-a', organization_id: 'org-a',
  first_name: 'Ada', last_name: 'Lovelace', job_title: 'Engineer',
};
const session = { data: { memberId: 'member-a', tenantId: 'tenant-a' } };
function response() {
  return {
    statusCode: 200, headers: {},
    setHeader(key, value) { this.headers[key] = value; },
    status(code) { this.statusCode = code; return this; },
    json(value) { this.body = value; return this; },
    end() { return this; },
  };
}
function database(organizationError = null) {
  const calls = [];
  return {
    calls,
    from(table) {
      calls.push(table);
      return {
        select() { return this; },
        eq() { return this; },
        async maybeSingle() {
          if (table === 'tenant') return { data: { slug: 'tenant-a', domain: 'a.example.test' } };
          if (table === 'tenant_user_member_link') return { data: null };
          if (table === 'organization') return {
            data: organizationError ? null : { id: 'org-a', tenant_id: 'tenant-a', name: 'Verified society' },
            error: organizationError,
          };
          throw new Error(`Unexpected query ${table}`);
        },
      };
    },
  };
}
const request = {
  method: 'GET', headers: { host: 'a.example.test' },
  query: { tenant: 'tenant-b', memberId: 'member-b', _publicView: '1' },
};
function dependencies(overrides = {}) {
  return {
    db: database(), readMember: async () => member, readSession: async () => session,
    resolveHostTenant: async host => {
      assert.equal(host, 'a.example.test');
      return { id: 'tenant-a' };
    },
    ...overrides,
  };
}

test('auth/me provides private host-scoped Canvas values without using preview/query identity', async () => {
  const res = response();
  await handler(request, res, dependencies());
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.id, 'member-a');
  assert.deepEqual(res.body.sessionRole, {
    status: 'missing', member_id: 'member-a', tenant_id: 'tenant-a', role_id: null, role: null,
  });
  assert.equal(res.body.canvasMemberSnapshot.values['member.first_name'], 'Ada');
  assert.equal(res.body.canvasMemberSnapshot.values['member.organization.name'], 'Verified society');
  assert.match(res.headers['Cache-Control'], /private, no-store/);
  assert.match(res.headers.Vary, /Cookie/);
});

test('auth/me leaves valid authentication intact but blanks Canvas on unresolved or mismatched host', async () => {
  for (const tenant of [null, { id: 'tenant-b' }]) {
    const db = database();
    const res = response();
    await handler(request, res, dependencies({ db, resolveHostTenant: async () => tenant }));
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.id, 'member-a');
    assert.equal(res.body.canvasMemberSnapshot, null);
    assert.ok(!db.calls.includes('organization'));
  }
});

test('auth/me logs optional projection failures and returns the valid member instead of 500', async (t) => {
  const warnings = [];
  t.mock.method(console, 'warn', (...args) => warnings.push(args.join(' ')));
  for (const overrides of [
    { db: database({ message: 'organisation unavailable' }) },
    { resolveHostTenant: async () => { throw new Error('host lookup unavailable'); } },
  ]) {
    const res = response();
    await handler(request, res, dependencies(overrides));
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.id, 'member-a');
    assert.equal(res.body.canvasMemberSnapshot, null);
    assert.equal(res.body.tenantSlug, 'tenant-a');
  }
  assert.equal(warnings.length, 2);
  assert.ok(warnings.every(message => message.includes('personalisation disabled')));
});

test('auth/me guest response stays null without looking up a Canvas organisation', async () => {
  const db = database();
  const res = response();
  let hostTenantReads = 0;
  await handler(request, res, dependencies({
    db,
    readMember: async () => null,
    resolveHostTenant: async () => {
      hostTenantReads += 1;
      throw new Error('guest host resolution should not start');
    },
  }));
  assert.equal(res.statusCode, 200);
  assert.equal(res.body, null);
  assert.equal(db.calls.length, 0);
  assert.equal(hostTenantReads, 0);
});