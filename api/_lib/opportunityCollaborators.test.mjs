import test from 'node:test';
import assert from 'node:assert/strict';
import { collaboratorOptions, validateCollaborator } from './opportunityCollaborators.js';

const access = { opportunity: { owner_kind: 'member', owner_id: 'owner' },
  collaborators: [{ principal_kind: 'member', principal_id: 'existing' }] };
function fixture({ primary = true, failure = false } = {}) {
  const rows = [
    ...Array.from({ length: 101 }, (_, i) => ({ id: `person-${String(i).padStart(3, '0')}`, tenant_id: 'tenant', organization_id: 'primary', email: 'person@example.test' })),
    { id: 'owner', tenant_id: 'tenant', organization_id: 'primary' },
    { id: 'existing', tenant_id: 'tenant', organization_id: 'primary' },
    { id: 'customer', tenant_id: 'tenant', organization_id: 'customer' },
    { id: 'foreign', tenant_id: 'other', organization_id: 'primary' },
    { id: 'deleted', tenant_id: 'tenant', organization_id: 'primary', email: 'deleted_old@deleted.local' },
  ];
  return { from(table) {
    const filters = []; let range, single = false;
    const q = {
      select() { return q; }, eq(k, v) { filters.push(row => row[k] === v); return q; },
      or() { filters.push(row => !row.email?.startsWith('deleted_')); return q; },
      order() { return q; }, range(a, b) { range = [a, b]; return q; },
      maybeSingle() { single = true; return q; },
      then(resolve) {
        let data = (table === 'organization' ? (primary ? [{ id: 'primary', tenant_id: 'tenant', is_primary: true }] : []) : rows).filter(row => filters.every(f => f(row)));
        if (range) data = data.slice(range[0], range[1] + 1);
        return Promise.resolve({ data: single ? data[0] || null : data, error: failure ? new Error('lookup failed') : null }).then(resolve);
      },
    };
    return q;
  } };
}
test('options are complete paginated primary-org members, excluding owner, existing and deleted members', async () => {
  const db = fixture();
  const first = await collaboratorOptions(db, 'tenant', access);
  assert.equal(first.nextOffset, 100);
  const second = await collaboratorOptions(db, 'tenant', access, first.nextOffset);
  assert.equal(second.nextOffset, null);
  const people = [...first.items, ...second.items];
  assert.equal(people.length, 101);
  assert.ok(people.every(row => row.id.startsWith('person-')));
});
test('write boundary refuses customer/foreign/deleted members, tenant users, owner and duplicate', async () => {
  const db = fixture();
  await validateCollaborator(db, 'tenant', access, { kind: 'member', id: 'person-000' });
  for (const id of ['customer', 'foreign', 'deleted', 'owner', 'existing']) {
    await assert.rejects(validateCollaborator(db, 'tenant', access, { kind: 'member', id }));
  }
  await assert.rejects(validateCollaborator(db, 'tenant', access, { kind: 'tenant_user', id: 'person-000' }));
});
test('missing primary organisation, invalid offset and query failure never expand to tenant-wide people', async () => {
  await assert.rejects(collaboratorOptions(fixture({ primary: false }), 'tenant', access), /primary organisation/);
  await assert.rejects(collaboratorOptions(fixture(), 'tenant', access, '-1'), /offset/);
  await assert.rejects(collaboratorOptions(fixture({ failure: true }), 'tenant', access), /lookup failed/);
});
