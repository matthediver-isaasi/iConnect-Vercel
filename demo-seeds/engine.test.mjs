// Safety-guard tests for the demo seed engine (mocked supabase client).
// Run: node --test demo-seeds/engine.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { seedDemoTenant, resetDemoData, deleteDemoTenant, createRng, MANIFEST_KEY } from './engine.mjs';

// Minimal chainable supabase mock. `rows` maps table -> array of row objects.
// Records every delete call with its applied filters.
function mockSb(rows, deletes = []) {
  const from = (table) => {
    const state = { table, filters: {}, op: 'select' };
    const chain = {
      select: () => chain,
      update: () => { state.op = 'update'; return chain; },
      insert: () => { state.op = 'insert'; return chain; },
      delete: () => { state.op = 'delete'; return chain; },
      eq: (k, v) => { state.filters[k] = v; return chain; },
      in: (k, v) => { state.filters[k] = v; return chain; },
      limit: () => chain,
      order: () => chain,
      maybeSingle: async () => ({ data: resolve()[0] || null, error: null }),
      single: async () => ({ data: resolve()[0] || null, error: null }),
      then: (res) => {
        if (state.op === 'delete') deletes.push({ table, filters: state.filters });
        return Promise.resolve({ data: resolve(), error: null, count: 0 }).then(res);
      },
    };
    const resolve = () => {
      const all = rows[table] || [];
      return all.filter(r => Object.entries(state.filters).every(([k, v]) =>
        Array.isArray(v) ? v.includes(r[k]) : r[k] === v));
    };
    return chain;
  };
  return { from };
}

const definition = {
  key: 'aesp', version: 'aesp-v1',
  tenant: { slug: 'aesp', name: 'AESP', adminEmail: 'x@aesp.example.com', adminFirstName: 'X', adminLastName: 'Y' },
  tablesWithoutTenantColumn: ['member_preference_value'],
  seed: async () => {},
};

const CUSTOMER_TENANT = { id: 't-real', slug: 'aesp', settings: {} }; // NOT demo-marked
const DEMO_TENANT = { id: 't-demo', slug: 'aesp', settings: { demo_seed: { key: 'aesp', version: 'aesp-v1' } } };

test('seed refuses an existing tenant without the demo marker', async () => {
  const sb = mockSb({ tenant: [CUSTOMER_TENANT], system_settings: [] });
  await assert.rejects(
    () => seedDemoTenant(definition, { sb, provisionTenant: async () => ({}) , log: () => {} }),
    /NOT marked as the 'aesp' demo tenant/
  );
});

test('seed refuses when marker belongs to a different seed key', async () => {
  const sb = mockSb({
    tenant: [{ id: 't-x', slug: 'aesp', settings: { demo_seed: { key: 'other-demo' } } }],
    system_settings: [],
  });
  await assert.rejects(
    () => seedDemoTenant(definition, { sb, provisionTenant: async () => ({}), log: () => {} }),
    /NOT marked/
  );
});

test('reset refuses a tenant without the demo marker/manifest', async () => {
  const sb = mockSb({ tenant: [CUSTOMER_TENANT], system_settings: [] });
  await assert.rejects(
    () => resetDemoData(definition, { sb, log: () => {} }),
    /NOT marked/
  );
});

test('delete refuses a tenant without the demo marker/manifest', async () => {
  const sb = mockSb({ tenant: [CUSTOMER_TENANT], system_settings: [] });
  await assert.rejects(
    () => deleteDemoTenant(definition, { sb, log: () => {} }),
    /NOT marked/
  );
});

test('reset refuses a manifest whose tenantId does not match', async () => {
  const manifest = { seedKey: 'aesp', version: 'aesp-v1', tenantId: 'someone-else', records: { member: ['m1'] } };
  const sb = mockSb({
    tenant: [DEMO_TENANT],
    system_settings: [{ tenant_id: 't-demo', setting_key: MANIFEST_KEY, setting_value: JSON.stringify(manifest) }],
  });
  await assert.rejects(() => resetDemoData(definition, { sb, log: () => {} }), /tenantId mismatch/);
});

test('reset deletes only manifest ids and always tenant-scopes tenant tables', async () => {
  const manifest = {
    seedKey: 'aesp', version: 'aesp-v1', tenantId: 't-demo',
    records: { member: ['m1', 'm2'], member_preference_value: ['p1'] },
  };
  const deletes = [];
  const sb = mockSb({
    tenant: [DEMO_TENANT],
    system_settings: [{ id: 's1', tenant_id: 't-demo', setting_key: MANIFEST_KEY, setting_value: JSON.stringify(manifest) }],
    member: [], member_preference_value: [],
  }, deletes);
  await resetDemoData(definition, { sb, log: () => {} });
  const memberDel = deletes.find(d => d.table === 'member');
  assert.ok(memberDel, 'member delete issued');
  assert.equal(memberDel.filters.tenant_id, 't-demo', 'member delete is tenant-scoped');
  assert.deepEqual(memberDel.filters.id, ['m1', 'm2'], 'member delete limited to manifest ids');
  const pvDel = deletes.find(d => d.table === 'member_preference_value');
  assert.ok(pvDel, 'pref value delete issued');
  assert.deepEqual(pvDel.filters.id, ['p1']);
  assert.ok(!deletes.some(d => d.table === 'tenant'), 'reset never deletes the tenant row');
});

test('rng is deterministic for a fixed seed', () => {
  const a = createRng('aesp-v1');
  const b = createRng('aesp-v1');
  const seqA = Array.from({ length: 20 }, () => a.int(0, 1000));
  const seqB = Array.from({ length: 20 }, () => b.int(0, 1000));
  assert.deepEqual(seqA, seqB);
});
