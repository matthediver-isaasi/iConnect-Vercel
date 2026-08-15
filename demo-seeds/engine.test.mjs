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
      // Additional filter methods used by image-linking helpers (pass-through
      // so the mock returns the normal resolve() result unaffected).
      ilike: () => chain,
      is: () => chain,
      not: () => chain,
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
  // Minimal storage mock: always returns an empty file list and a placeholder
  // public URL. Enough for the image-linking helpers to early-return (no
  // members/orgs/events in the mock rows mean zero eligible rows before
  // storage is consulted).
  const storage = {
    from: () => ({
      list: async () => ({ data: [], error: null }),
      upload: async () => ({ error: null }),
      getPublicUrl: () => ({ data: { publicUrl: 'https://example.com/placeholder' } }),
    }),
  };
  return { from, storage };
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

// ---------------------------------------------------------------------------
// Image-linking automatic invocation tests
// ---------------------------------------------------------------------------
// These tests verify that the engine runs avatar/logo/event-image linking
// passes automatically after definition.seed() completes, and that the
// imageLinking config is forwarded to the helpers. Because the mock sb
// returns empty tables, all three helpers early-return with { linked:0,
// missing:0 } (no storage reads needed for empty result sets, except logos
// which is wrapped in its own try/catch for the primary-org link step).

test('image linking passes run automatically after seed() and record manifest counts', async () => {
  const logs = [];
  const sb = mockSb({
    tenant: [DEMO_TENANT],
    system_settings: [],
    // Empty tables so all three helpers complete with linked=0, missing=0.
    member: [], organization: [], event: [], complex_event: [],
  });
  const result = await seedDemoTenant(definition, {
    sb,
    provisionTenant: async () => ({}),
    log: (msg) => logs.push(msg),
  });
  // Engine must complete without throwing.
  assert.ok(result.manifest, 'manifest returned');
  // All three counts must appear in the manifest (0 is a valid linked count).
  assert.equal(result.manifest.counts.avatars_linked, 0, 'avatars_linked recorded');
  assert.equal(result.manifest.counts.logos_linked, 0, 'logos_linked recorded');
  assert.equal(result.manifest.counts.event_images_linked, 0, 'event_images_linked recorded');
  // No *_missing key when nothing is missing.
  assert.ok(!('avatars_missing' in result.manifest.counts), 'no avatars_missing when zero');
  assert.ok(!('event_images_missing' in result.manifest.counts), 'no event_images_missing when zero');
});

test('imageLinking config is forwarded — custom domain and slug prefix, seeds without error', async () => {
  // A hypothetical community-club tenant definition with its own domain and
  // slug prefix — no image linking code in the definition itself.
  const clubDefinition = {
    key: 'clubdemo',
    version: 'clubdemo-v1',
    tenant: {
      slug: 'clubdemo',
      name: 'Community Club Demo',
      adminEmail: 'admin@clubdemo.example.com',
      adminFirstName: 'Admin',
      adminLastName: 'User',
    },
    imageLinking: {
      demoDomain: 'clubdemo.example.com',
      eventSlugPrefix: 'club-',
    },
    seed: async () => {},
  };
  const clubTenant = {
    id: 't-club',
    slug: 'clubdemo',
    settings: { demo_seed: { key: 'clubdemo', version: 'clubdemo-v1' } },
  };
  const sb = mockSb({
    tenant: [clubTenant],
    system_settings: [],
    member: [], organization: [], event: [], complex_event: [],
  });
  const result = await seedDemoTenant(clubDefinition, {
    sb,
    provisionTenant: async () => ({}),
    log: () => {},
  });
  assert.ok(result.manifest, 'manifest returned for non-AESP definition');
  // Engine must populate the three image-linking count keys regardless of
  // which domain or slug prefix the definition declares.
  assert.equal(result.manifest.counts.avatars_linked, 0);
  assert.equal(result.manifest.counts.logos_linked, 0);
  assert.equal(result.manifest.counts.event_images_linked, 0);
});
