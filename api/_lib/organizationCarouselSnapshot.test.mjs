import test from 'node:test';
import assert from 'node:assert/strict';
import { createOrganizationSnapshotAdapter, loadOrganizationCarouselSnapshot } from './organizationCarouselSnapshot.js';

function snapshot() {
  return { version: 1, tenant_id: 'tenant',
    dynamic_directory: [], system_settings: [], preference_field: [],
    organization_preference_value: [],
    organization: [
      { id: 'a', tenant_id: 'tenant', name: null, logo_url: null },
      { id: 'b', tenant_id: 'tenant', name: 'Same', logo_url: null },
      { id: 'c', tenant_id: 'tenant', name: 'Same', logo_url: null },
      { id: 'd', tenant_id: 'tenant', name: 'Alpha', logo_url: null },
    ] };
}

test('snapshot adapter combines scope, IN, ordering, inclusive range, limit and projection', async () => {
  const db = createOrganizationSnapshotAdapter(snapshot(), 'tenant');
  const { data } = await db.from('organization').select('id, name').eq('tenant_id', 'tenant')
    .in('id', ['a', 'b', 'c', 'd']).order('name').order('id', { ascending: false }).range(1, 3).limit(2);
  assert.deepEqual(data, [{ id: 'c', name: 'Same' }, { id: 'b', name: 'Same' }]);
  assert.deepEqual((await db.from('organization').select('id').eq('tenant_id', 'other')).data, []);
  assert.deepEqual((await db.from('organization').select('id').eq('name', null)).data, []);
  assert.deepEqual((await db.from('organization').select('id').in('name', [null])).data, []);
});

test('adapter preserves independent reads, own snapshot, null ordering and empty pages', async () => {
  const input = snapshot();
  const db = createOrganizationSnapshotAdapter(input, 'tenant');
  input.organization.length = 0;
  assert.deepEqual((await db.from('organization').select('id').order('name', { ascending: false, nullsFirst: true }).limit(1)).data, [{ id: 'a' }]);
  assert.equal((await db.from('organization').select('*').range(0, 499)).data.length, 4);
  assert.deepEqual((await db.from('organization').select('*').range(4, 503)).data, []);
});

test('adapter fails explicitly on unsupported tables, columns, operators and pagination', () => {
  const db = createOrganizationSnapshotAdapter(snapshot(), 'tenant');
  assert.throws(() => db.from('member'), /Unsupported/);
  assert.throws(() => db.from('organization').select('email'), /Unsupported/);
  assert.throws(() => db.from('organization').eq('is_active', true), /Unsupported/);
  assert.throws(() => db.from('organization').in('id', null), /Invalid/);
  assert.throws(() => db.from('organization').order('id', { foreignTable: 'other' }), /Unsupported/);
  assert.throws(() => db.from('organization').range(-1, 4), /Invalid/);
  assert.throws(() => db.from('organization').or('tenant_id.eq.other'), TypeError);
});

test('adapter rejects cross-tenant records and either foreign preference-value parent', () => {
  const input = snapshot();
  input.organization[0].tenant_id = 'other';
  assert.throws(() => createOrganizationSnapshotAdapter(input, 'tenant'), /scope/);
  for (const [organization_id, field_id] of [['foreign', 'field'], ['a', 'foreign']]) {
    const value = snapshot();
    value.preference_field = [{ id: 'field', tenant_id: 'tenant', entity_scope: 'organization' }];
    value.organization_preference_value = [{ id: 'value', organization_id, field_id, value: 'private' }];
    assert.throws(() => createOrganizationSnapshotAdapter(value, 'tenant'), /scope/);
  }
});

test('only explicit missing snapshot function errors permit fallback', async () => {
  const args = { tenantId: 'tenant', source: 'primary-organization' };
  for (const code of ['PGRST202', '42883']) {
    assert.equal(await loadOrganizationCarouselSnapshot({ rpc: async () => ({
      data: null, error: { code, message: 'function public.organization_carousel_snapshot does not exist' },
    }) }, args), null);
  }
  for (const error of [
    { code: '42501', message: 'organization_carousel_snapshot permission denied' },
    { code: '57014', message: 'statement timeout' },
    { code: 'PGRST202', message: 'some_other_function not found' },
    { code: '54000', message: 'snapshot exceeds safety limits' },
  ]) {
    await assert.rejects(loadOrganizationCarouselSnapshot({ rpc: async () => ({ data: null, error }) }, args), /Unable to read/);
  }
  await assert.rejects(loadOrganizationCarouselSnapshot({ rpc: async () => ({ data: null, error: null }) }, args), /Invalid/);
});
