import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolveFormOwnerOrganization, validateFormOwners } from './formOwners.js';

const owner = '11111111-1111-4111-8111-111111111111';
const outsider = '22222222-2222-4222-8222-222222222222';
function database({ organizations = [{ id: 'org', tenant_id: 'tenant', is_primary: true }],
  members = [{ id: owner, tenant_id: 'tenant', organization_id: 'org', email: 'owner@example.test' }],
  failure = false } = {}) {
  return {
    from(table) {
      let rows = table === 'organization' ? organizations : members;
      const query = {
        select() { return this; },
        eq(key, value) { rows = rows.filter(row => row[key] === value); return this; },
        limit(count) { rows = rows.slice(0, count); return this; },
        not() { rows = rows.filter(row => row.email && !row.email.startsWith('deleted_')); return this; },
        in(key, values) { rows = rows.filter(row => values.includes(row[key])); return this; },
        then(resolve, reject) { return Promise.resolve({ data: rows, error: failure ? new Error('database unavailable') : null }).then(resolve, reject); },
      };
      return query;
    },
  };
}
const validate = (db, owners) => validateFormOwners({ db, tenantId: 'tenant', payload: { owners } });

test('accepts only tenant default-organisation members and permits clearing owners', async () => {
  assert.equal(await validate(database(), [owner]), null);
  assert.equal(await validate(database(), [owner, owner]), null);
  assert.equal(await validate(database({ failure: true }), []), null);
  assert.equal(await validateFormOwners({ db: database({ failure: true }), tenantId: 'tenant', payload: { title: 'Changed' } }), null);
});

test('rejects outside-organisation, cross-tenant, deleted and nonexistent members', async () => {
  for (const row of [
    { organization_id: 'other', tenant_id: 'tenant', email: 'outside@example.test' },
    { organization_id: 'org', tenant_id: 'other', email: 'outside@example.test' },
    { organization_id: 'org', tenant_id: 'tenant', email: 'deleted_member@deleted.local' },
  ]) {
    assert.match(await validate(database({ members: [{ id: outsider, ...row }] }), [outsider]), /must belong/);
  }
  assert.match(await validate(database(), [outsider]), /must belong/);
});

test('missing or ambiguous default organisation never falls back to another organisation', async () => {
  for (const organizations of [
    [],
    [{ id: 'org', tenant_id: 'tenant', is_primary: false }],
    [{ id: 'org', tenant_id: 'other', is_primary: true }],
    [{ id: 'org', tenant_id: 'tenant', is_primary: true }, { id: 'other', tenant_id: 'tenant', is_primary: true }],
  ]) {
    assert.equal(await resolveFormOwnerOrganization(database({ organizations }), 'tenant'), null);
    assert.match(await validate(database({ organizations }), [owner]), /unique default organisation/);
  }
});

test('invalid payloads are rejected and database failures are not accepted as eligibility', async () => {
  for (const owners of [null, 'owner', {}, [null], ['bad-id']]) {
    assert.match(await validate(database(), owners), /valid member records/);
  }
  await assert.rejects(validate(database({ failure: true }), [owner]), /database unavailable/);
});

test('picker, search and create/update endpoints enforce the same owner policy', () => {
  for (const path of ['api/entities/[entity]/index.js', 'api/entities/[entity]/[id].js']) {
    const source = readFileSync(path, 'utf8');
    assert.match(source, /await validateFormOwners\(/);
    assert.match(source, /INVALID_FORM_OWNERS/);
  }
  assert.match(readFileSync('client/src/components/forms/FormOwnersSelector.jsx', 'utf8'), /organizationId="__form_owners__"/);
  assert.match(readFileSync('api/members/search.js', 'utf8'), /resolveFormOwnerOrganization\(supabase, tenantId\)/);
});
