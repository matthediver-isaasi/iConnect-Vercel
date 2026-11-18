import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { sessionUnavailable } from './sessionAvailability.js';

const source = fs.readFileSync(new URL('./session.js', import.meta.url), 'utf8');
const promotion = source.slice(source.indexOf('async function tryPromoteMemberToTenantUser'),
  source.indexOf('const SESSION_NOT_PROVIDED'));
const session = { id: 'test-session', data: { identityId: 'i1', tenantId: 't1', memberId: 'm1', userType: 'member' } };
const admin = { id: 'membership', identity_id: 'i1', tenant_id: 't1', status: 'active', role: 'admin', membership_type: 'member', tenant: { id: 't1' } };
const legacy = { id: 'u1', identity_id: 'i1', tenant_id: 't1', status: 'active', role: 'admin', tenant: { id: 't1' } };

function fixture({ memberships = [], users = [], failure, update = true, identities = [{ id: 'i1' }] } = {}) {
  const calls = [], writes = [];
  const tables = { tenant_membership: memberships, tenant_user: users, tenant_identity: identities };
  const db = { from(table) {
    const filters = [];
    const call = { table, filters };
    calls.push(call);
    const resolve = async (single) => {
      if (failure === table) return { data: null, error: { code: 'DB_ERROR' } };
      const rows = tables[table].filter(row => filters.every(([key, value]) => row[key] === value));
      if (single && rows.length > 1) return { data: null, error: { code: 'PGRST116' } };
      return { data: single ? rows[0] || null : rows, error: null };
    };
    const query = {
      select(columns) { assert.ok(!columns.includes('tenant_user_id')); return query; },
      eq(key, value) { filters.push([key, value]); return query; },
      limit() { return query; },
      single() { assert.fail('Optional account lookup must not require a row'); },
      maybeSingle() { return resolve(true); },
      then(ok, fail) { return resolve(false).then(ok, fail); },
    };
    return query;
  } };
  const promote = new Function('supabase', 'updateSession', 'sessionUnavailable',
    `${promotion}; return tryPromoteMemberToTenantUser;`)(db, async (id, data) => {
    writes.push(data); return update;
  }, sessionUnavailable);
  return { run: () => promote(session, {}), calls, writes };
}

test('ordinary members repeatedly resolve absence without errors, writes or invalid joins', async () => {
  const f = fixture({ memberships: [{ ...admin, role: 'member' }] });
  for (let i = 0; i < 4; i++) assert.equal(await f.run(), null);
  assert.equal(f.writes.length, 0);
  assert.equal(f.calls.length, 8);
  for (const call of f.calls) {
    assert.deepEqual(call.filters, [['identity_id', 'i1'], ['tenant_id', 't1']]);
  }
});

test('unified administrators promote without a legacy account and preserve member provenance', async () => {
  for (const role of ['owner', 'admin']) {
    const f = fixture({ memberships: [{ ...admin, role }] });
    const result = await f.run();
    assert.equal(result.id, 'i1');
    assert.equal(result._isUnifiedIdentity, true);
    assert.equal(result._sessionTenantId, 't1');
    assert.equal(f.writes[0].memberId, 'm1');
    assert.equal(f.writes[0].tenantUserId, 'i1');
  }
});

test('linked legacy administrators retain existing access and suspension fence', async () => {
  const f = fixture({ users: [legacy] });
  assert.equal((await f.run()).id, 'u1');
  assert.equal(f.writes.length, 1);
  for (const options of [
    { users: [{ ...legacy, status: 'inactive' }], memberships: [admin] },
    { users: [legacy], memberships: [{ ...admin, status: 'inactive' }] },
    { memberships: [{ ...admin, status: 'inactive' }] },
  ]) {
    const denied = fixture(options);
    assert.equal(await denied.run(), null);
    assert.equal(denied.writes.length, 0);
  }
});

test('tenant and identity mismatches cannot promote', async () => {
  for (const mismatch of [{ tenant_id: 't2' }, { identity_id: 'i2' }]) {
    const f = fixture({ users: [{ ...legacy, ...mismatch }], memberships: [{ ...admin, ...mismatch }] });
    assert.equal(await f.run(), null);
    assert.equal(f.writes.length, 0);
  }
});

test('backend failures are unavailable rather than absence, and never elevate', async () => {
  for (const failure of ['tenant_user', 'tenant_membership', 'tenant_identity']) {
    const f = fixture({ memberships: [admin], failure });
    await assert.rejects(f.run(), { code: 'SESSION_UNAVAILABLE', status: 503 });
    assert.equal(f.writes.length, 0);
  }
});

test('duplicate legacy links and missing identities fail closed', async () => {
  await assert.rejects(fixture({ users: [legacy, { ...legacy, id: 'u2' }] }).run(), { code: 'SESSION_UNAVAILABLE' });
  const f = fixture({ memberships: [admin], identities: [] });
  assert.equal(await f.run(), null);
  assert.equal(f.writes.length, 0);
});

test('revocation is observed on the next request without cached authority', async () => {
  const row = { ...admin };
  const f = fixture({ memberships: [row] });
  assert.ok(await f.run());
  row.role = 'member';
  assert.equal(await f.run(), null);
  assert.equal(f.writes.length, 1);
});

test('durable session fence refusal cannot return in-memory elevated access', async () => {
  const f = fixture({ memberships: [admin], update: false });
  assert.equal(await f.run(), null);
});
