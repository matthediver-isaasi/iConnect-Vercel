import test from 'node:test';
import assert from 'node:assert/strict';
import { loadCanvasMemberSnapshot } from './canvasMemberValues.js';

const member = {
  id: 'viewer', tenant_id: 'tenant-a', organization_id: 'org-a',
  first_name: 'Ada', last_name: 'Lovelace', job_title: 'Engineer',
};
const session = { data: { memberId: 'viewer', tenantId: 'tenant-a' } };
const tenant = { id: 'tenant-a' };
function database(organization, error = null) {
  const calls = [];
  const query = {
    select(value) { calls.push(['select', value]); return query; },
    eq(key, value) { calls.push(['eq', key, value]); return query; },
    async maybeSingle() { return { data: organization, error }; },
  };
  return { calls, from(table) { calls.push(['from', table]); return query; } };
}

test('session member projection uses only the same-tenant linked organisation and four allowlisted values', async () => {
  const db = database({ id: 'org-a', tenant_id: 'tenant-a', name: 'Computing Society' });
  const result = await loadCanvasMemberSnapshot({ member, session, tenant, db });
  assert.deepEqual(result, {
    memberId: 'viewer', tenantId: 'tenant-a', organizationId: 'org-a',
    values: {
      'member.first_name': 'Ada', 'member.last_name': 'Lovelace',
      'member.job_title': 'Engineer', 'member.organization.name': 'Computing Society',
    },
  });
  assert.deepEqual(db.calls, [
    ['from', 'organization'], ['select', 'id, tenant_id, name'],
    ['eq', 'id', 'org-a'], ['eq', 'tenant_id', 'tenant-a'],
  ]);
});

test('missing identity, unvalidated session, host/tenant mismatch and switched member fail closed without querying', async () => {
  const db = database(null);
  for (const changes of [
    { member: null }, { session: null }, { tenant: null }, { tenant: {} },
    { member: { ...member, tenant_id: null } },
    { session: { data: { memberId: 'other', tenantId: 'tenant-a' } } },
    { session: { data: { memberId: 'viewer', tenantId: 'tenant-b' } } },
    { session: { data: { memberId: 'viewer' } } }, { tenant: { id: 'tenant-b' } },
  ]) {
    assert.equal(await loadCanvasMemberSnapshot({ member, session, tenant, db, ...changes }), null);
  }
  assert.equal(db.calls.length, 0);
});

test('missing, malformed or cross-tenant organization never supplies a name', async () => {
  for (const organization of [
    null, { id: 'org-a', tenant_id: 'tenant-b', name: 'Private B' },
    { id: 'org-b', tenant_id: 'tenant-a', name: 'Other org' },
    { id: 'org-a', tenant_id: 'tenant-a', name: { secret: true } },
  ]) {
    const result = await loadCanvasMemberSnapshot({ member, session, tenant, db: database(organization) });
    assert.equal(result.values['member.organization.name'], '');
  }
  const result = await loadCanvasMemberSnapshot({
    member: { ...member, organization_id: null, first_name: null, job_title: {} }, session, tenant,
  });
  assert.equal(result.organizationId, null);
  assert.equal(result.values['member.organization.name'], '');
  assert.equal(result.values['member.first_name'], '');
  assert.equal(result.values['member.job_title'], '');
});

test('organisation lookup errors are explicit rather than using a stale cached name', async () => {
  await assert.rejects(loadCanvasMemberSnapshot({
    member, session, tenant, db: database(null, { message: 'database offline' }),
  }), /Failed to load Canvas member organisation/);
});