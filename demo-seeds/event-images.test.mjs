// Tests for demo-seeds/event-images.mjs
// Run: node --test demo-seeds/event-images.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  demoEventImageStoragePath,
  applyDemoEventImage,
  linkExistingDemoEventImages,
  buildEventImagePrompt,
} from './event-images.mjs';

const TENANT_ID = 't-demo';
const URL = 'https://cdn.example.com/demo/event.jpg';

/**
 * Minimal chainable supabase mock (same style as logos.test.mjs) plus
 * ilike-prefix filters and a storage stub.
 * `tables` is a map of tableName -> array of row objects.
 * `updates` accumulates { table, filters, nullFilters, likeFilters, patch }.
 * `storageFiles` is a list of file names under the tenant folder.
 */
function mockSb({ tables = {}, updates = [], storageFiles = [] } = {}) {
  const from = (table) => {
    const state = { table, filters: {}, nullFilters: {}, likeFilters: {}, patch: null, op: 'select' };
    const chain = {
      select: () => chain,
      update: (patch) => { state.op = 'update'; state.patch = patch; return chain; },
      eq: (k, v) => { state.filters[k] = v; return chain; },
      is: (k, v) => { state.nullFilters[k] = v; return chain; },
      ilike: (k, v) => { state.likeFilters[k] = v; return chain; },
      limit: () => chain,
      order: () => chain,
      maybeSingle: async () => ({ data: resolve()[0] || null, error: null }),
      then: (res) => Promise.resolve(run()).then(res),
    };
    const likeMatch = (val, pattern) => {
      const re = new RegExp('^' + String(pattern).replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*') + '$', 'i');
      return re.test(String(val ?? ''));
    };
    const resolve = () => (tables[table] || []).filter((r) =>
      Object.entries(state.filters).every(([k, v]) => r[k] === v) &&
      Object.entries(state.nullFilters).every(([k, v]) => (v === null ? r[k] == null : r[k] != null)) &&
      Object.entries(state.likeFilters).every(([k, v]) => likeMatch(r[k], v)));
    const run = () => {
      if (state.op === 'update') {
        const matched = resolve();
        updates.push({ table, filters: { ...state.filters }, nullFilters: { ...state.nullFilters }, likeFilters: { ...state.likeFilters }, patch: state.patch });
        for (const row of matched) Object.assign(row, state.patch);
        return { data: matched.map((r) => ({ id: r.id })), error: null };
      }
      return { data: resolve(), error: null };
    };
    return chain;
  };
  const storage = {
    from: () => ({
      list: async (_prefix, { offset = 0 } = {}) => ({
        data: offset === 0 ? storageFiles.map((name) => ({ name })) : [],
        error: null,
      }),
      getPublicUrl: (path) => ({ data: { publicUrl: `https://cdn.example.com/${path}` } }),
    }),
  };
  return { from, storage };
}

const fileNameFor = (slug) => demoEventImageStoragePath(TENANT_ID, slug).split('/')[1];

// ---------------------------------------------------------------------------

test('storage path is deterministic and slug-keyed', () => {
  const a = demoEventImageStoragePath(TENANT_ID, 'demo-x');
  assert.equal(a, demoEventImageStoragePath(TENANT_ID, ' demo-x '));
  assert.notEqual(a, demoEventImageStoragePath(TENANT_ID, 'demo-y'));
  assert.match(a, new RegExp(`^${TENANT_ID}/event-[0-9a-f]{40}\\.jpg$`));
});

test('applyDemoEventImage links fill-null with is_sample provenance on event', async () => {
  const tables = { event: [{ id: 'e1', tenant_id: TENANT_ID, slug: 'demo-x', is_sample: true, image_url: null }] };
  const updates = [];
  const ok = await applyDemoEventImage({ sb: mockSb({ tables, updates }), tenantId: TENANT_ID, table: 'event', eventId: 'e1', url: URL, log: () => {} });
  assert.equal(ok, true);
  assert.equal(updates.length, 1);
  assert.equal(updates[0].patch.image_url, URL);
  assert.equal(updates[0].filters.is_sample, true, 'UPDATE must carry is_sample provenance');
  assert.equal(updates[0].likeFilters.slug, 'demo-%', 'UPDATE must also carry the seed slug-prefix provenance');
  assert.ok('image_url' in updates[0].nullFilters, 'UPDATE must re-check image_url IS NULL');
});

test('applyDemoEventImage uses slug-prefix provenance on complex_event (no is_sample)', async () => {
  const tables = { complex_event: [{ id: 'c1', tenant_id: TENANT_ID, slug: 'demo-conf', image_url: null }] };
  const updates = [];
  const ok = await applyDemoEventImage({ sb: mockSb({ tables, updates }), tenantId: TENANT_ID, table: 'complex_event', eventId: 'c1', url: URL, log: () => {} });
  assert.equal(ok, true);
  assert.equal(updates[0].likeFilters.slug, 'demo-%', 'UPDATE must carry the seed slug-prefix provenance');
  assert.ok(!('is_sample' in updates[0].filters));
});

test('existing image is never replaced', async () => {
  const tables = { event: [{ id: 'e1', tenant_id: TENANT_ID, slug: 'demo-x', is_sample: true, image_url: 'https://cdn.example.com/manual.jpg' }] };
  const updates = [];
  const logs = [];
  const ok = await applyDemoEventImage({ sb: mockSb({ tables, updates }), tenantId: TENANT_ID, table: 'event', eventId: 'e1', url: URL, log: (m) => logs.push(m) });
  assert.equal(ok, false);
  assert.equal(updates.length, 0, 'no UPDATE when image already set');
  assert.ok(logs.some((l) => /keeps existing image/i.test(l)));
});

test('non-seeded rows are rejected (wrong slug prefix / not sample)', async () => {
  const tables = {
    event: [
      { id: 'e2', tenant_id: TENANT_ID, slug: 'demo-x', is_sample: false, image_url: null },
      { id: 'e4', tenant_id: TENANT_ID, slug: 'real-event', is_sample: true, image_url: null }, // sample but non-demo slug
    ],
    complex_event: [{ id: 'c2', tenant_id: TENANT_ID, slug: 'real-conference', image_url: null }],
  };
  const updates = [];
  const sb = mockSb({ tables, updates });
  await assert.rejects(applyDemoEventImage({ sb, tenantId: TENANT_ID, table: 'event', eventId: 'e2', url: URL, log: () => {} }), /not found/);
  await assert.rejects(applyDemoEventImage({ sb, tenantId: TENANT_ID, table: 'event', eventId: 'e4', url: URL, log: () => {} }), /not found/);
  await assert.rejects(applyDemoEventImage({ sb, tenantId: TENANT_ID, table: 'complex_event', eventId: 'c2', url: URL, log: () => {} }), /not found/);
  assert.equal(updates.length, 0, 'no UPDATE may be emitted for non-seeded rows');
  assert.equal(tables.event[1].image_url, null, 'sample event with non-demo slug untouched');
});

test('linkExistingDemoEventImages links stored images across both tables and counts missing', async () => {
  const tables = {
    event: [
      { id: 'e1', tenant_id: TENANT_ID, slug: 'demo-a', is_sample: true, image_url: null },
      { id: 'e2', tenant_id: TENANT_ID, slug: 'demo-b', is_sample: true, image_url: null }, // no stored file
      { id: 'e3', tenant_id: TENANT_ID, slug: 'demo-c', is_sample: true, image_url: 'set' }, // already has one
    ],
    complex_event: [
      { id: 'c1', tenant_id: TENANT_ID, slug: 'demo-conf', image_url: null },
    ],
  };
  const updates = [];
  const logs = [];
  const sb = mockSb({ tables, updates, storageFiles: [fileNameFor('demo-a'), fileNameFor('demo-conf'), 'unrelated.png'] });
  const { linked, missing } = await linkExistingDemoEventImages({ sb, tenantId: TENANT_ID, log: (m) => logs.push(m) });
  assert.equal(linked, 2, 'demo-a + demo-conf linked');
  assert.equal(missing, 1, 'demo-b has no stored image');
  assert.equal(tables.event[0].image_url, `https://cdn.example.com/${demoEventImageStoragePath(TENANT_ID, 'demo-a')}`);
  assert.equal(tables.complex_event[0].image_url, `https://cdn.example.com/${demoEventImageStoragePath(TENANT_ID, 'demo-conf')}`);
  assert.equal(tables.event[2].image_url, 'set', 'already-set image untouched');
  assert.ok(logs.some((l) => /warning: 1 seeded event/.test(l)), 'missing warning cites the README pass');
});

test('buildEventImagePrompt picks a scene from type/title and stays text/logo free', () => {
  const webinar = buildEventImagePrompt({ event_type: 'Webinar', title: 'Scope 3 Emissions' }, { sector: 'environmental and sustainability' });
  assert.match(webinar, /online video presentation/);
  assert.match(webinar, /environmental theme/i);
  const conf = buildEventImagePrompt({ event_type: 'Conference', title: 'Annual Conference' });
  assert.match(conf, /conference hall/);
  const visit = buildEventImagePrompt({ event_type: 'Networking', title: 'Sustainable Construction Site Visit' });
  assert.match(visit, /construction site/, 'title keywords beat weaker tag matches only when regex order says so');
  for (const p of [webinar, conf]) {
    assert.match(p, /no visible readable text, no logos, no watermarks/);
    assert.match(p, /16:9 landscape/);
  }
});
